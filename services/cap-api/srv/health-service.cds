@path: '/health'
@requires: 'any'
service HealthService {
  function liveness() returns String;
  function readiness() returns String;
}
