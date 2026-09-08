// Deterministic child-process failure fixture for test-release-runner.mjs.
// It is never part of CORE_E2E or OPTIONAL_E2E.
if (process.env.RELEASE_RUNNER_SELF_TEST !== '1') {
  console.error('This fixture is only valid inside the release-runner self-test')
  process.exit(2)
}

console.error('intentional release-runner child failure')
process.exit(17)
