import { Router } from 'express'
import type { Pool } from 'pg'
import type { AppConfig } from '../../config/env.ts'
import { authContext, requireAdmin } from '../../middleware/authorize.ts'
import { csrfProtection } from '../../middleware/csrf.ts'
import { evidence } from '../../middleware/request-context.ts'
import { exactObject, uuid } from '../../shared/validation.ts'
import { HierarchyService } from '../hierarchy/hierarchy-service.ts'
import { V5AdminService } from './v5-admin-service.ts'

export function adminRouter(pool:Pool,config:AppConfig):Router {
  const router=Router(), service=new V5AdminService(pool,config), hierarchy=new HierarchyService(pool), csrf=csrfProtection(pool,config)
  const actor=(res:Parameters<typeof authContext>[0])=>({userId:authContext(res).userId})
  const id=(value:string|string[]|undefined)=>uuid(typeof value==='string'?value:'','id')
  router.use(requireAdmin)
  router.get('/accounts',async(_req,res)=>res.json(await service.listAccounts()))
  router.get('/accounts/:id',async(req,res)=>res.json(await service.account(id(req.params.id))))
  router.post('/accounts',csrf,async(req,res)=>res.status(201).json(await service.createAccount(actor(res),exactObject(req.body,['username','staffIdentifier','displayName','jobTitle','accountType','temporaryPassword','isActive','unitId']),evidence(res))))
  router.patch('/accounts/:id',csrf,async(req,res)=>res.json(await service.updateAccount(actor(res),id(req.params.id),exactObject(req.body,['staffIdentifier','displayName','jobTitle']),evidence(res))))
  router.post('/accounts/:id/enable',csrf,async(req,res)=>{exactObject(req.body??{},[]);res.json(await service.setAccountActive(actor(res),id(req.params.id),true,evidence(res)))} )
  router.post('/accounts/:id/disable',csrf,async(req,res)=>{exactObject(req.body??{},[]);res.json(await service.setAccountActive(actor(res),id(req.params.id),false,evidence(res)))} )
  router.post('/accounts/:id/unlock',csrf,async(req,res)=>{exactObject(req.body??{},[]);res.json(await service.unlock(actor(res),id(req.params.id),evidence(res)))} )
  router.post('/accounts/:id/reset-temporary-password',csrf,async(req,res)=>res.json(await service.resetPassword(actor(res),id(req.params.id),exactObject(req.body,['temporaryPassword']).temporaryPassword,evidence(res))))
  router.get('/operational-units',async(_req,res)=>res.json(await service.units()))
  router.post('/operational-units',csrf,async(req,res)=>res.status(201).json(await service.createUnit(actor(res),exactObject(req.body,['kind','name','routingUnitId']),evidence(res))))
  router.get('/operational-units/:unitId',async(req,res)=>{const unit=await hierarchy.getOperationalUnit(uuid(req.params.unitId,'unitId'));if(!unit)res.sendStatus(404);else res.json(unit)})
  router.get('/operational-units/:unitId/members',async(req,res)=>res.json(await service.members(uuid(req.params.unitId,'unitId'))))
  router.post('/operational-units/:unitId/memberships',csrf,async(req,res)=>res.status(201).json(await service.transfer(actor(res),uuid(req.params.unitId,'unitId'),exactObject(req.body,['userId']),evidence(res))))
  router.post('/operational-units/:unitId/manager-assignments',csrf,async(req,res)=>res.status(201).json(await service.replaceManager(actor(res),uuid(req.params.unitId,'unitId'),exactObject(req.body,['managerUserId','replacementReason']),evidence(res))))
  router.get('/operational-units/:unitId/manager-history',async(req,res)=>res.json(await hierarchy.getManagerHistory(uuid(req.params.unitId,'unitId'))))
  router.get('/operational-units/:unitId/subordinates',async(req,res)=>res.json(await hierarchy.listSubordinates(uuid(req.params.unitId,'unitId'))))
  return router
}
