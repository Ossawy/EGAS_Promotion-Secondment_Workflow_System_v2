import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { Queryable } from '../../db/types.ts'
import type { AppConfig } from '../../config/env.ts'
import { withTransaction } from '../../db/transaction.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { AppError, isUniqueViolation } from '../../shared/errors.ts'
import { bool, optionalText, password, text, uuid } from '../../shared/validation.ts'
import { LocalAuthenticationProvider } from '../auth/local-authentication-provider.ts'
import { recordAuditEvent, recordSecurityEvent } from '../audit/security-events.ts'

type Actor={userId:string}
type AuditLogQuery={skip:number,top:number,eventType:string|null,actor:string|null,from:string|null,to:string|null}
const SAFE_AUDIT_DETAIL_KEYS=new Set([
  'changedFields','reason','personnelNumber','positionTitle','snapshotYear','requestType',
  'stageCode','fromStage','toStage','decisionType','recommendation','lastPromotionReport',
  'jobCategoryCode','qualificationStatus','organizationalDependency','sourceLabel','isActive',
  'managerHandledPersonally','totalRows','validRows','warningRows','blockedRows','importedRows'
])

function safeAuditDetails(details:unknown):Record<string,unknown>{
  if(!details||typeof details!=='object'||Array.isArray(details))return {}
  const safe:Record<string,unknown>={}
  for(const [key,value] of Object.entries(details as Record<string,unknown>)){
    if(!SAFE_AUDIT_DETAIL_KEYS.has(key))continue
    if(key==='changedFields'){
      if(Array.isArray(value))safe[key]=value.filter(item=>typeof item==='string').slice(0,20)
      continue
    }
    if(typeof value==='string')safe[key]=value.slice(0,1000)
    else if(typeof value==='number'&&Number.isFinite(value))safe[key]=value
    else if(typeof value==='boolean'||value===null)safe[key]=value
  }
  return safe
}

const audit=async(db:any,actor:Actor,type:string,subjectType:string,subjectId:string,details:unknown,e:RequestEvidence)=>{
  await recordAuditEvent(db,{actorUserId:actor.userId,eventType:type,subjectType,subjectId,details:(details??{}) as Record<string,unknown>})
  await recordSecurityEvent(db,{actorUserId:actor.userId,eventType:type,...e})
}

export class V5AdminService {
  private auth:LocalAuthenticationProvider
  constructor(private readonly pool:Pool,config:AppConfig){this.auth=new LocalAuthenticationProvider(pool,config)}
  async dashboard(actor:Actor){
    const [accounts,units,snapshot,activity,notifications]=await Promise.all([
      this.pool.query(`SELECT is_active AS "isActive",locked_until AS "lockedUntil" FROM user_account`),
      this.pool.query(`SELECT kind,COUNT(*)::integer AS count FROM operational_unit WHERE is_active=TRUE GROUP BY kind`),
      this.pool.query(`SELECT b.id,b.snapshot_year AS "snapshotYear",b.activated_at AS "activatedAt",COUNT(s.id)::integer AS "employeeCount" FROM import_batch b LEFT JOIN employee_annual_snapshot s ON s.import_batch_id=b.id WHERE b.status='ACTIVATED' GROUP BY b.id,b.snapshot_year,b.activated_at ORDER BY b.snapshot_year DESC,b.activated_at DESC NULLS LAST LIMIT 1`),
      this.pool.query(`SELECT e.id,e.event_type AS "eventType",e.subject_type AS "subjectType",e.subject_id AS "subjectId",e.details,e.created_at AS "createdAt",COALESCE(e.actor_snapshot->>'displayName',a.display_name) AS "actorDisplayName" FROM audit_event e LEFT JOIN user_account a ON a.id=e.actor_user_id ORDER BY e.created_at DESC,e.id DESC LIMIT 8`),
      this.pool.query(`SELECT id,notification_type AS "notificationType",is_read AS "isRead",created_at AS "createdAt" FROM notification WHERE recipient_user_id=$1 ORDER BY created_at DESC,id DESC LIMIT 8`,[actor.userId])
    ])
    const now=Date.now(),accountRow={total:accounts.rows.length,active:accounts.rows.filter(row=>row.isActive).length,inactive:accounts.rows.filter(row=>!row.isActive).length,locked:accounts.rows.filter(row=>row.lockedUntil&&new Date(row.lockedUntil).getTime()>now).length}
    const unitCounts={HR:0,ORG:0,AUTH:0}
    for(const row of units.rows){if(row.kind in unitCounts)unitCounts[row.kind as keyof typeof unitCounts]=Number(row.count)}
    return {accounts:accountRow,operationalUnits:{...unitCounts,total:unitCounts.HR+unitCounts.ORG+unitCounts.AUTH},activeSnapshot:snapshot.rows[0]??null,recentActivity:activity.rows.map(row=>({...row,details:safeAuditDetails(row.details),createdAt:new Date(row.createdAt).toISOString()})),notifications:{unread:notifications.rows.filter(row=>!row.isRead).length,recent:notifications.rows.map(row=>({...row,createdAt:new Date(row.createdAt).toISOString()}))}}
  }
  async auditLog(query:AuditLogQuery){
    const values:unknown[]=[],conditions:string[]=[]
    if(query.eventType)conditions.push(`e.event_type=$${values.push(query.eventType)}`)
    if(query.actor)conditions.push(`(a.display_name ILIKE $${values.push(`%${query.actor}%`)} OR a.username ILIKE $${values.length} OR e.actor_snapshot->>'displayName' ILIKE $${values.length} OR e.actor_snapshot->>'username' ILIKE $${values.length})`)
    if(query.from)conditions.push(`e.created_at >= $${values.push(`${query.from}T00:00:00.000Z`)}::timestamptz`)
    if(query.to){const exclusiveTo=new Date(`${query.to}T00:00:00.000Z`);exclusiveTo.setUTCDate(exclusiveTo.getUTCDate()+1);conditions.push(`e.created_at < $${values.push(exclusiveTo.toISOString())}::timestamptz`)}
    const where=conditions.length?`WHERE ${conditions.join(' AND ')}`:''
    const subjectJoins=`
      LEFT JOIN user_account subject_account ON e.subject_type='user_account' AND subject_account.id=e.subject_id
      LEFT JOIN operational_unit subject_unit ON e.subject_type='operational_unit' AND subject_unit.id=e.subject_id
      LEFT JOIN workflow_request subject_request ON e.subject_type='workflow_request' AND subject_request.id=e.subject_id`
    const select=`SELECT e.id,e.actor_user_id AS "actorUserId",e.event_type AS "eventType",e.subject_type AS "subjectType",e.subject_id AS "subjectId",e.details,e.created_at AS "createdAt",
      COALESCE(e.actor_snapshot->>'displayName',a.display_name) AS "actorDisplayName",
      COALESCE(e.actor_snapshot->>'username',a.username) AS "actorUsername",
      COALESCE(e.actor_snapshot->>'jobTitle',a.job_title) AS "actorJobTitle",
      COALESCE(e.actor_snapshot->>'operationalUnitName',actor_unit.name) AS "actorUnitName",
      COALESCE(e.subject_snapshot->>'label',e.subject_snapshot->>'displayName',e.subject_snapshot->>'name',e.subject_snapshot->>'unitName',e.subject_snapshot->>'requestNumber',subject_account.display_name,subject_unit.name,subject_request.request_number,e.details->>'personnelNumber',e.details->>'sourceLabel',e.details->>'positionTitle') AS "subjectLabel",
      COALESCE(e.subject_snapshot->>'requestNumber',subject_request.request_number) AS "requestNumber"
      FROM audit_event e
      LEFT JOIN user_account a ON a.id=e.actor_user_id
      LEFT JOIN user_unit_membership actor_membership ON actor_membership.user_id=a.id AND actor_membership.effective_to IS NULL
      LEFT JOIN operational_unit actor_unit ON actor_unit.id=actor_membership.unit_id
      ${subjectJoins}`
    const pageValues=[...values,query.skip,query.top]
    const [events,total]=await Promise.all([
      this.pool.query(`${select} ${where} ORDER BY e.created_at DESC,e.id DESC OFFSET $${values.length+1} LIMIT $${values.length+2}`,pageValues),
      this.pool.query(`SELECT COUNT(*)::integer AS count FROM audit_event e LEFT JOIN user_account a ON a.id=e.actor_user_id ${where}`,values)
    ])
    const uuidPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    const requestIds=[...new Set(events.rows.map(row=>row.details?.requestId).filter((value):value is string=>typeof value==='string'&&uuidPattern.test(value)))]
    const requestRows=requestIds.length?(await this.pool.query(`SELECT id,request_number AS "requestNumber" FROM workflow_request WHERE id IN (${requestIds.map((_,index)=>`$${index+1}`).join(',')})`,requestIds)).rows:[]
    const requestNumbers=new Map(requestRows.map(row=>[row.id,row.requestNumber]))
    const items=events.rows.map(row=>{const requestNumber=row.requestNumber??requestNumbers.get(row.details?.requestId)??null;return {...row,details:safeAuditDetails(row.details),subjectLabel:row.subjectLabel??requestNumber,requestNumber,createdAt:new Date(row.createdAt).toISOString()}})
    return {items,total:Number(total.rows[0]?.count??0),skip:query.skip,top:query.top}
  }
  async listAccounts(){return (await this.pool.query(`SELECT id,username,staff_identifier AS "staffIdentifier",display_name AS "displayName",job_title AS "jobTitle",account_type AS "accountType",must_change_password AS "mustChangePassword",is_active AS "isActive",locked_until AS "lockedUntil",version,created_at AS "createdAt" FROM user_account ORDER BY username`)).rows}
  private async accountFrom(db:Queryable,id:string){const r=await db.query(`SELECT id,username,staff_identifier AS "staffIdentifier",display_name AS "displayName",job_title AS "jobTitle",account_type AS "accountType",must_change_password AS "mustChangePassword",is_active AS "isActive",locked_until AS "lockedUntil",version FROM user_account WHERE id=$1`,[id]);if(!r.rows[0])throw new AppError(404,'Account not found');return r.rows[0]}
  async account(id:string){return await this.accountFrom(this.pool,uuid(id,'account id'))}
  async createAccount(actor:Actor,body:Record<string,unknown>,e:RequestEvidence){const accountType=body.accountType==='ADMIN'||body.accountType==='OPERATIONAL'?body.accountType:null;if(!accountType)throw new AppError(400,'accountType must be ADMIN or OPERATIONAL');const id=randomUUID(), unitId=body.unitId===undefined?null:uuid(body.unitId,'unitId');if(accountType==='ADMIN'&&unitId)throw new AppError(400,'ADMIN cannot have operational membership');if(accountType==='OPERATIONAL'&&!unitId)throw new AppError(400,'OPERATIONAL requires initial unitId');const hash=await this.auth.hashPassword(password(body.temporaryPassword,'temporaryPassword'));try{return await withTransaction(this.pool,async db=>{const forbiddenKeys=['isManager','role','activeRole'];for(const k of forbiddenKeys){if(body[k]!==undefined)throw new AppError(400,`Field ${k} is forbidden`)}await db.query(`INSERT INTO user_account(id,username,staff_identifier,display_name,job_title,account_type,password_hash,must_change_password,is_active) VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,$8)`,[id,text(body.username,'username',120,3),optionalText(body.staffIdentifier,'staffIdentifier',120),text(body.displayName,'displayName',240),optionalText(body.jobTitle,'jobTitle',240),accountType,hash,body.isActive===undefined?true:bool(body.isActive,'isActive')]);if(unitId)await db.query(`INSERT INTO user_unit_membership(id,user_id,unit_id,created_by_user_id) VALUES($1,$2,$3,$4)`,[randomUUID(),id,unitId,actor.userId]);await audit(db,actor,'ACCOUNT_CREATED','user_account',id,{accountType,unitId},e);return await this.accountFrom(db,id)})}catch(error){if(isUniqueViolation(error))throw new AppError(409,'Username or active membership already exists','CONFLICT');throw error}}
  async updateAccount(actor:Actor,id:string,body:Record<string,unknown>,e:RequestEvidence){
    const displayName=text(body.displayName,'displayName',240)
    const jobTitle=optionalText(body.jobTitle,'jobTitle',240)
    const staffIdentifier=optionalText(body.staffIdentifier,'staffIdentifier',120)
    await withTransaction(this.pool,async db=>{
      const current=(await db.query(`SELECT staff_identifier AS "staffIdentifier",display_name AS "displayName",job_title AS "jobTitle" FROM user_account WHERE id=$1 FOR UPDATE`,[id])).rows[0]
      if(!current)throw new AppError(404,'Account not found')
      const changedFields:string[]=[]
      const changes:Record<string,{from:string|null,to:string|null}>={}
      for(const [field,from,to] of [['staffIdentifier',current.staffIdentifier,staffIdentifier],['displayName',current.displayName,displayName],['jobTitle',current.jobTitle,jobTitle]] as const){if(from!==to){changedFields.push(field);changes[field]={from:from??null,to:to??null}}}
      await db.query(`UPDATE user_account SET staff_identifier=$2,display_name=$3,job_title=$4,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1`,[id,staffIdentifier,displayName,jobTitle])
      await audit(db,actor,'ACCOUNT_UPDATED','user_account',id,{affectedUserId:id,changedFields,changes},e)
    })
    return await this.account(id)
  }
  async setAccountActive(actor:Actor,id:string,active:boolean,e:RequestEvidence){return await withTransaction(this.pool,async db=>{const target=(await db.query(`SELECT account_type AS "accountType",is_active AS "isActive" FROM user_account WHERE id=$1 FOR UPDATE`,[id])).rows[0];if(!target)throw new AppError(404,'Account not found');if(!active&&target.isActive){const managed=(await db.query(`SELECT ou.name FROM unit_manager_assignment uma JOIN operational_unit ou ON ou.id=uma.unit_id WHERE uma.manager_user_id=$1 AND uma.effective_to IS NULL LIMIT 1`,[id])).rows[0];if(managed)throw new AppError(409,`Replace the current manager of ${managed.name} before disabling this account`,'MANAGER_REPLACEMENT_REQUIRED');if(target.accountType==='ADMIN'){const remaining=await db.query(`SELECT 1 FROM user_account WHERE account_type='ADMIN' AND is_active=TRUE AND id<>$1 LIMIT 1`,[id]);if(!remaining.rows[0])throw new AppError(409,'At least one active ADMIN account is required','LAST_ADMIN_REQUIRED')}}await db.query(`UPDATE user_account SET is_active=$2,version=version+1 WHERE id=$1`,[id,active]);if(!active)await db.query(`UPDATE auth_session SET revoked_at=CURRENT_TIMESTAMP,revoked_reason='ACCOUNT_DISABLED' WHERE user_id=$1 AND revoked_at IS NULL`,[id]);await audit(db,actor,active?'ACCOUNT_ENABLED':'ACCOUNT_DISABLED','user_account',id,{},e);return await this.accountFrom(db,id)})}
  async unlock(actor:Actor,id:string,e:RequestEvidence){await withTransaction(this.pool,async db=>{const updated=await db.query(`UPDATE user_account SET locked_until=NULL,failed_login_count=0,version=version+1 WHERE id=$1`,[id]);if(!updated.rowCount)throw new AppError(404,'Account not found');await audit(db,actor,'ACCOUNT_UNLOCKED','user_account',id,{},e)});return await this.account(id)}
  async resetPassword(actor:Actor,id:string,value:unknown,e:RequestEvidence){const hash=await this.auth.hashPassword(password(value,'temporaryPassword'));await withTransaction(this.pool,async db=>{await db.query(`UPDATE user_account SET password_hash=$2,must_change_password=TRUE,password_changed_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1`,[id,hash]);await db.query(`UPDATE auth_session SET revoked_at=CURRENT_TIMESTAMP,revoked_reason='PASSWORD_RESET' WHERE user_id=$1 AND revoked_at IS NULL`,[id]);await audit(db,actor,'PASSWORD_RESET','user_account',id,{},e)});return await this.account(id)}
  async units(){return (await this.pool.query(`SELECT u.id,u.kind,u.name,u.routing_unit_id AS "routingUnitId",u.is_active AS "isActive",r.code AS "routingUnitCode",r.name_ar AS "routingUnitName" FROM operational_unit u LEFT JOIN routing_unit r ON r.id=u.routing_unit_id ORDER BY u.kind,u.name`)).rows}
  async createUnit(actor:Actor,body:Record<string,unknown>,e:RequestEvidence){const kind=body.kind;if(kind!=='HR'&&kind!=='ORG'&&kind!=='AUTH')throw new AppError(400,'kind must be HR, ORG, or AUTH');const routing=body.routingUnitId===undefined?null:uuid(body.routingUnitId,'routingUnitId');if((kind==='AUTH')!==Boolean(routing))throw new AppError(400,'AUTH requires routingUnitId; HR/ORG must not have one');const id=randomUUID();try{return await withTransaction(this.pool,async db=>{await db.query(`INSERT INTO operational_unit(id,kind,name,routing_unit_id,is_active) VALUES($1,$2,$3,$4,TRUE)`,[id,kind,text(body.name,'name',240),routing]);await audit(db,actor,'OPERATIONAL_UNIT_CREATED','operational_unit',id,{kind},e);return (await db.query(`SELECT id,kind,name,routing_unit_id AS "routingUnitId",is_active AS "isActive" FROM operational_unit WHERE id=$1`,[id])).rows[0]!})}catch(error){if(isUniqueViolation(error)){const msg=kind==='AUTH'?'Active routing unit conflict':'Active unit constraint conflict';throw new AppError(409,msg,'CONFLICT')}throw error}}
  async members(unitId:string){return (await this.pool.query(`SELECT m.id AS "membershipId",a.id,a.username,a.display_name AS "displayName",a.job_title AS "jobTitle",m.effective_from AS "effectiveFrom",ma.id AS "managerAssignmentId" FROM user_unit_membership m JOIN user_account a ON a.id=m.user_id LEFT JOIN unit_manager_assignment ma ON ma.unit_id=m.unit_id AND ma.manager_user_id=m.user_id AND ma.effective_to IS NULL WHERE m.unit_id=$1 AND m.effective_to IS NULL ORDER BY a.display_name`,[unitId])).rows}
  async transfer(actor:Actor,unitId:string,body:Record<string,unknown>,e:RequestEvidence){const userId=uuid(body.userId,'userId');try{return await withTransaction(this.pool,async db=>{await db.query(`SELECT id FROM operational_unit WHERE id=$1 FOR UPDATE`,[unitId]);const user=(await db.query(`SELECT account_type,is_active FROM user_account WHERE id=$1 FOR UPDATE`,[userId])).rows[0];if(!user||user.account_type!=='OPERATIONAL'||!user.is_active)throw new AppError(400,'Membership target must be an active OPERATIONAL account');const manager=(await db.query(`SELECT 1 FROM unit_manager_assignment WHERE manager_user_id=$1 AND effective_to IS NULL`,[userId])).rows[0];if(manager)throw new AppError(409,'Replace manager before transferring membership','MANAGER_REPLACEMENT_REQUIRED');await db.query(`UPDATE user_unit_membership SET effective_to=CURRENT_TIMESTAMP,ended_by_user_id=$2,end_reason='TRANSFER' WHERE user_id=$1 AND effective_to IS NULL`,[userId,actor.userId]);const id=randomUUID();await db.query(`INSERT INTO user_unit_membership(id,user_id,unit_id,created_by_user_id) VALUES($1,$2,$3,$4)`,[id,userId,unitId,actor.userId]);await audit(db,actor,'MEMBERSHIP_TRANSFERRED','user_unit_membership',id,{userId,unitId},e);return {membershipId:id}})}catch(error){if(isUniqueViolation(error))throw new AppError(409,'Only one active membership is allowed','CONFLICT');throw error}}
  async replaceManager(actor:Actor,unitId:string,body:Record<string,unknown>,e:RequestEvidence){const managerId=uuid(body.managerUserId,'managerUserId'),reason=optionalText(body.replacementReason,'replacementReason',500);try{return await withTransaction(this.pool,async db=>{ const admin=(await db.query(`SELECT account_type FROM user_account WHERE id=$1`,[actor.userId])).rows[0]; if(!admin||admin.account_type!=='ADMIN')throw new AppError(403,'Admin authority required'); const unit=(await db.query(`SELECT id,is_active FROM operational_unit WHERE id=$1 FOR UPDATE`,[unitId])).rows[0];if(!unit||!unit.is_active)throw new AppError(404,'Active operational unit not found');const target=(await db.query(`SELECT a.id FROM user_account a JOIN user_unit_membership m ON m.user_id=a.id AND m.unit_id=$2 AND m.effective_to IS NULL WHERE a.id=$1 AND a.account_type='OPERATIONAL' AND a.is_active FOR UPDATE`,[managerId,unitId])).rows[0];if(!target)throw new AppError(400,'Manager must be an active OPERATIONAL member of this unit');await db.query(`SELECT id FROM unit_manager_assignment WHERE unit_id=$1 AND effective_to IS NULL FOR UPDATE`,[unitId]);await db.query(`UPDATE unit_manager_assignment SET effective_to=CURRENT_TIMESTAMP,ended_by_user_id=$2,replacement_reason=$3 WHERE unit_id=$1 AND effective_to IS NULL`,[unitId,actor.userId,reason]);const id=randomUUID();await db.query(`INSERT INTO unit_manager_assignment(id,unit_id,manager_user_id,assigned_by_user_id) VALUES($1,$2,$3,$4)`,[id,unitId,managerId,actor.userId]);await audit(db,actor,'MANAGER_REPLACED','unit_manager_assignment',id,{unitId,managerId},e);return {managerAssignmentId:id}})}catch(error){if(isUniqueViolation(error))throw new AppError(409,'Concurrent manager replacement conflict; retry','MANAGER_ASSIGNMENT_CONFLICT');throw error}}
}
