import type { Pool } from 'pg'
import { AppError } from '../../shared/errors.ts'

export class HierarchyService {
  constructor(private readonly pool: Pool) {}
  async getCurrentMembership(userId:string) { return (await this.pool.query(`SELECT id,user_id AS "userId",unit_id AS "unitId",effective_from AS "effectiveFrom" FROM user_unit_membership WHERE user_id=$1 AND effective_to IS NULL`,[userId])).rows[0] ?? null }
  async getOperationalUnit(unitId:string) { return (await this.pool.query(`SELECT id,kind,name,routing_unit_id AS "routingUnitId",is_active AS "isActive" FROM operational_unit WHERE id=$1`,[unitId])).rows[0] ?? null }
  async getCurrentManager(unitId:string) { return (await this.pool.query(`SELECT id,manager_user_id AS "managerUserId",effective_from AS "effectiveFrom" FROM unit_manager_assignment WHERE unit_id=$1 AND effective_to IS NULL`,[unitId])).rows[0] ?? null }
  async isCurrentManager(userId:string,unitId:string):Promise<boolean> { return Boolean((await this.pool.query(`SELECT 1 FROM user_account a JOIN user_unit_membership m ON m.user_id=a.id AND m.effective_to IS NULL AND m.unit_id=$2 JOIN unit_manager_assignment ma ON ma.unit_id=$2 AND ma.manager_user_id=a.id AND ma.effective_to IS NULL WHERE a.id=$1 AND a.account_type='OPERATIONAL' AND a.is_active`,[userId,unitId])).rows[0]) }
  async verifyMemberOfUnit(userId:string,unitId:string):Promise<boolean> { return Boolean((await this.pool.query(`SELECT 1 FROM user_unit_membership WHERE user_id=$1 AND unit_id=$2 AND effective_to IS NULL`,[userId,unitId])).rows[0]) }
  async listSubordinates(unitId:string) { return (await this.pool.query(`SELECT a.id,a.username,a.display_name AS "displayName",a.job_title AS "jobTitle",m.id AS "membershipId" FROM user_unit_membership m JOIN user_account a ON a.id=m.user_id WHERE m.unit_id=$1 AND m.effective_to IS NULL AND a.is_active AND NOT EXISTS(SELECT 1 FROM unit_manager_assignment ma WHERE ma.unit_id=$1 AND ma.manager_user_id=a.id AND ma.effective_to IS NULL) ORDER BY a.display_name`,[unitId])).rows }
  async getManagerHistory(unitId:string) { return (await this.pool.query(`SELECT ma.id,ma.manager_user_id AS "managerUserId",a.display_name AS "displayName",ma.effective_from AS "effectiveFrom",ma.effective_to AS "effectiveTo",ma.replacement_reason AS "replacementReason" FROM unit_manager_assignment ma JOIN user_account a ON a.id=ma.manager_user_id WHERE ma.unit_id=$1 ORDER BY ma.effective_from DESC`,[unitId])).rows }
  async requireCurrentManager(userId:string,unitId:string) { if (!await this.isCurrentManager(userId,unitId)) throw new AppError(403,'Current unit manager required','UNIT_MANAGER_REQUIRED') }
}
