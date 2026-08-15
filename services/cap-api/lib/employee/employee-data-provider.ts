export interface EmployeeSnapshotRecord {
  id: string
  employeeId: string
  snapshotYear: number
  personnelNumber: string
  employeeName: string
  subgroup: string | null
  routingUnitId: string
  sourceRoutingUnit: string | null
  currentJobTitle: string | null
  performanceRating: string | null
  qualificationSource1: string | null
  qualificationSource2: string | null
  qualificationDate: string | null
}

export interface EmployeeDataProvider {
  getActiveSnapshotYear(): Promise<number | null>
  findEligibleEmployee(personnelNumber: string, year?: number): Promise<EmployeeSnapshotRecord | null>
}
