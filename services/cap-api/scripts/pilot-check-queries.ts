import type { Service } from '@sap/cds'

export type PrivilegedAdminAccount = {
  ID: string
}

function activeManageAdminsRole() {
  return {
    ref: [{
      id: 'roles',
      where: [
        { ref: ['isActive'] }, '=', { val: true },
        'and', { ref: ['role'] }, '=', { val: 'ADMIN' },
        'and', { ref: ['canManageAdmins'] }, '=', { val: true }
      ]
    }]
  }
}

export async function findActivePrivilegedAdminAccounts(
  db: Pick<Service, 'run'>
): Promise<PrivilegedAdminAccount[]> {
  return await db.run(
    SELECT.from('egas.UserAccount')
      .columns('ID')
      .where({ isActive: true, exists: activeManageAdminsRole() })
  ) as PrivilegedAdminAccount[]
}
