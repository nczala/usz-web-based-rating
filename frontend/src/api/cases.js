import { request } from './http'

export function getCase(caseId) {
  return request(`/cases/${caseId}`)
}

export function getCaseDicoms(caseId) {
  return request(`/cases/${caseId}/dicoms`)
}
