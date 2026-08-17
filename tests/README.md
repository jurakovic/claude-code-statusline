# Tests

Small smoke tests for the dependency-free statusline:

```bash
node tests/statusline-smoke.test.js
```

They execute `statusline.js` in a VM harness with stdin, stdout and the environment injected, and use only Node.js built-ins.
