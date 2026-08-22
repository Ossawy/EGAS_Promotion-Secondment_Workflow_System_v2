import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { withTransaction } from '../../db/transaction.ts'
import type { Queryable } from '../../db/types.ts'
import type { RequestEvidence } from '../../middleware/request-context.ts'
import { AppError } from '../../shared/errors.ts'
import { password as validPassword } from '../../shared/validation.ts'
import { LocalAuthenticationProvider } from './local-authentication-provider.ts'
import { fingerprintIdentifier } from './security.ts'
import type { IssuedSession, SafeUserContext } from './types.ts'
import { recordAuditEvent, recordSecurityEvent } from '../audit/security-events.ts'

type Account = { id:string; username:string; staffIdentifier:string|null; displayName:string; jobTitle:string|null; accountType:'ADMIN'|'OPERATIONAL'; passwordHash:string; mustChangePassword:boolean; isActive:boolean; failedLoginCount:number; lockedUntil:Date|string|null }
const cols = `id,username,staff_identifier AS "staffIdentifier",display_name AS "displayName",job_title AS "jobTitle",account_type AS "accountType",password_hash AS "passwordHash",must_change_password AS "mustChangePassword",is_active AS "isActive",failed_login_count AS "failedLoginCount",locked_until AS "lockedUntil"`
const username = (value: unknown) => typeof value === 'string' && /^[\p{L}\p{N}._@-]{3,120}$/u.test(value.trim()) ? value.trim() : ''

export class AuthService {
  readonly provider: LocalAuthenticationProvider
  private dummy?: Promise<string>
  constructor(private readonly pool: Pool, private readonly config: AppConfig) { this.provider = new LocalAuthenticationProvider(pool, config) }
  private async dummyHash() { return this.dummy ??= this.provider.hashPassword('synthetic-non-account-password') }
  private async context(db: Queryable, account: Account): Promise<SafeUserContext> {
    const result = await db.query<{membershipId:string;unitId:string;unitKind:'HR'|'ORG'|'AUTH';routingUnitId:string|null;routingUnitName:string|null;managerAssignmentId:string|null}>(`SELECT m.id AS "membershipId",u.id AS "unitId",u.kind AS "unitKind",u.routing_unit_id AS "routingUnitId",r.name_ar AS "routingUnitName",ma.id AS "managerAssignmentId" FROM user_unit_membership m JOIN operational_unit u ON u.id=m.unit_id LEFT JOIN routing_unit r ON r.id=u.routing_unit_id LEFT JOIN unit_manager_assignment ma ON ma.unit_id=u.id AND ma.manager_user_id=m.user_id AND ma.effective_to IS NULL WHERE m.user_id=$1 AND m.effective_to IS NULL`, [account.id])
    const row = result.rows[0]
    return { userId:account.id, username:account.username, staffIdentifier:account.staffIdentifier, displayName:account.displayName, jobTitle:account.jobTitle, accountType:account.accountType, mustChangePassword:account.mustChangePassword, operationalContext:row ? {membershipId:row.membershipId,unitId:row.unitId,unitKind:row.unitKind,routingUnitId:row.routingUnitId,routingUnitName:row.routingUnitName,isManager:Boolean(row.managerAssignmentId),managerAssignmentId:row.managerAssignmentId} : null }
  }
  private async issue(db: Queryable, account: Account, evidence: RequestEvidence, rotatedFrom: string|null = null): Promise<IssuedSession> {
    const sessionId=randomUUID(), sessionToken=this.provider.generateSessionToken(), csrfToken=this.provider.generateSessionToken()
    await db.query(`INSERT INTO auth_session(id,user_id,token_hash,csrf_secret_hash,rotated_from_session_id,idle_expires_at,absolute_expires_at,created_ip,user_agent) VALUES($1,$2,$3,$4,$5,CURRENT_TIMESTAMP+$6::interval,CURRENT_TIMESTAMP+$7::interval,$8,$9)`, [sessionId,account.id,this.provider.hashSessionToken(sessionToken),this.provider.hashSessionToken(csrfToken),rotatedFrom,`${this.config.auth.idleMinutes} minutes`,`${this.config.auth.absoluteHours} hours`,evidence.ipAddress,evidence.userAgent?.slice(0,1000)??null])
    return {sessionId,sessionToken,csrfToken,absoluteExpiresAt:new Date(Date.now()+this.config.auth.absoluteHours*3600000).toISOString(),context:await this.context(db,account)}
  }
  async login(usernameValue:unknown,passwordValue:unknown,evidence:RequestEvidence):Promise<IssuedSession> {
    const normalized=username(usernameValue)
    const supplied=typeof passwordValue==='string'?passwordValue:''
    const fingerprint=fingerprintIdentifier(normalized||'invalid',this.config)
    const outcome=await withTransaction(this.pool,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtext('egas.auth.attempts'))")
      const result=normalized
        ? await db.query<Account>(`SELECT ${cols} FROM user_account WHERE username=$1 FOR UPDATE`,[normalized])
        : {rows:[] as Account[]}
      const account=result.rows[0]
      const match=await this.provider.verifyPassword(account?.passwordHash??await this.dummyHash(),supplied)
      const locked=Boolean(account && (account.failedLoginCount >= this.config.auth.loginFailureLimit || (account.lockedUntil && new Date(account.lockedUntil)>new Date())))
      if(!account||!match||!account.isActive||locked){
        if(account&&account.isActive&&!locked&&!match){
          await db.query(`UPDATE user_account SET failed_login_count=failed_login_count+1,updated_at=CURRENT_TIMESTAMP WHERE id=$1`,[account.id])
          await db.query(`UPDATE user_account SET locked_until=CURRENT_TIMESTAMP WHERE id=$1 AND failed_login_count >= $2`,[account.id,this.config.auth.loginFailureLimit])
        }
        await recordSecurityEvent(db,{actorUserId:null,eventType:'LOGIN_FAILED',...evidence,details:{identifierFingerprint:fingerprint}})
        await recordAuditEvent(db,{actorUserId:null,eventType:'LOGIN_FAILED',subjectType:account?'user_account':null,subjectId:account?.id??null})
        return {error:new AppError(401,'Invalid username or password','AUTHENTICATION_FAILED')} as const
      }
      await db.query(`UPDATE user_account SET failed_login_count=0,locked_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=$1`,[account.id])
      const issued=await this.issue(db,account,evidence)
      await recordSecurityEvent(db,{actorUserId:account.id,eventType:'LOGIN_SUCCEEDED',...evidence})
      await recordAuditEvent(db,{actorUserId:account.id,eventType:'LOGIN_SUCCEEDED',subjectType:'user_account',subjectId:account.id})
      return {issued} as const
    })
    if('error' in outcome)throw outcome.error
    return outcome.issued
  }
  async getContext(userId:string,sessionId:string){ const a=await this.pool.query<Account>(`SELECT ${cols} FROM user_account WHERE id=$1 AND is_active`,[userId]); const s=await this.pool.query(`SELECT 1 FROM auth_session WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL AND idle_expires_at>CURRENT_TIMESTAMP AND absolute_expires_at>CURRENT_TIMESTAMP`,[sessionId,userId]); if(!a.rows[0]||!s.rows[0]) throw new AppError(401,'Authentication required'); return await this.context(this.pool,a.rows[0]) }
  async validateSession(sessionId:string,evidence:RequestEvidence){ return await withTransaction(this.pool,async db=>{ const s=await db.query(`SELECT s.user_id,a.id,a.is_active,a.password_hash FROM auth_session s JOIN user_account a ON s.user_id=a.id WHERE s.id=$1 AND s.revoked_at IS NULL AND s.idle_expires_at > NOW() AND s.absolute_expires_at > NOW()`,[sessionId]); const row=s.rows[0]; if(!row)throw new AppError(401,'Authentication required','AUTHENTICATION_FAILED'); if(!row.is_active)throw new AppError(401,'Account disabled','AUTHENTICATION_FAILED'); return await this.context(db, {id:row.id,username:'',staffIdentifier:null,displayName:'',jobTitle:null,accountType:'OPERATIONAL',passwordHash:row.password_hash,mustChangePassword:false,isActive:true,failedLoginCount:0,lockedUntil:null}) }) }
  async logout(userId:string,sessionId:string,evidence:RequestEvidence){ await withTransaction(this.pool,async db=>{await db.query(`UPDATE auth_session SET revoked_at=CURRENT_TIMESTAMP,revoked_reason='LOGOUT' WHERE id=$1 AND user_id=$2 AND revoked_at IS NULL`,[sessionId,userId]);await recordSecurityEvent(db,{actorUserId:userId,eventType:'LOGOUT',...evidence});await recordAuditEvent(db,{actorUserId:userId,eventType:'LOGOUT',subjectType:'user_account',subjectId:userId})}) }
  async changePassword(userId:string,sessionId:string,current:unknown,next:unknown,evidence:RequestEvidence):Promise<IssuedSession>{ const newPassword=validPassword(next); if(typeof current!=='string') throw new AppError(400,'Current password required'); return await withTransaction(this.pool,async db=>{ const a=(await db.query<Account>(`SELECT ${cols} FROM user_account WHERE id=$1 FOR UPDATE`,[userId])).rows[0]; if(!a||!await this.provider.verifyPassword(a.passwordHash,current)) throw new AppError(401,'Current password is incorrect'); const hash=await this.provider.hashPassword(newPassword); await db.query(`UPDATE user_account SET password_hash=$2,must_change_password=FALSE,password_changed_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=$1`,[userId,hash]); await db.query(`UPDATE auth_session SET revoked_at=CURRENT_TIMESTAMP,revoked_reason='PASSWORD_CHANGED' WHERE user_id=$1 AND revoked_at IS NULL`,[userId]); await recordSecurityEvent(db,{actorUserId:userId,eventType:'PASSWORD_CHANGED',...evidence});await recordAuditEvent(db,{actorUserId:userId,eventType:'PASSWORD_CHANGED',subjectType:'user_account',subjectId:userId}); a.mustChangePassword=false; return await this.issue(db,a,evidence,sessionId) }) }
  /** @deprecated The v5 API has no active-role switching. */
  async selectActiveRole(_userId?:string,_sessionId?:string,_role?:unknown,_evidence?:RequestEvidence): Promise<import('./types.ts').IssuedSession> { throw new AppError(404,'Active-role selection is not available','OBSOLETE_ROUTE') }
}
