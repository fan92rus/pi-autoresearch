Now I have all the evidence. Here is the structured review.

---

## Review: feat/agile-test-528 — Security fixes in auth.js and users.js

### What was checked

- `git diff master..feat/agile-test-528` — all 6 changed files (178 insertions, 28 deletions)
- Source code of `src/auth.js` and `src/users.js` on the feature branch
- Test files `tests/auth.test.js` and `tests/users.test.js`
- Test execution: `node --test "tests/*.test.js"`

---

### Dimension scores

| Dimension | Score | Evidence |
|-----------|-------|----------|
| **Hardcoded credentials removed** | ✅ PASS | `login()` no longer compares against `admin`/`secret123`; token is `crypto.randomBytes(32)`, not `"hardcoded-token-"` |
| **SQL injection fixed** | ✅ PASS | `deleteUser` uses `{ text: "DELETE FROM users WHERE id = $1", params: [userId] }` — parameterized, no string concatenation |
| **Proper hashing** | ✅ PASS | `crypto.scryptSync(password, salt, 64)` with 16-byte random salt + `crypto.timingSafeEqual` for constant-time comparison |
| **No plaintext passwords** | ✅ PASS | `password` field replaced with `passwordHash: hashPassword(password)` in `createUser` |
| **Tests present** | ✅ PASS | 6 tests in `auth.test.js` (hashPassword, verifyPassword, login); 6 tests in `users.test.js` (createUser, deleteUser, listUsers) |
| **Tests pass** | ✅ PASS | 12/12 tests green (run via `node --test "tests/*.test.js"`) |

---

### Detailed findings

**1. Hardcoded credentials — FIXED**
- `src/auth.js` line 12 (old): `if (username === "admin" && password === "secret123")` — removed entirely.
- `login()` now accepts a `findUser` callback and delegates password verification to `verifyPassword(password, user.passwordHash)`.
- Token generation: `crypto.randomBytes(32).toString("hex")` — random, not predictable.

**2. SQL injection — FIXED**
- `src/users.js` line 19 (old): `const query = "DELETE FROM users WHERE id = " + userId;` — removed.
- New code (line 18–21): `{ text: "DELETE FROM users WHERE id = $1", params: [userId] }` — value is bound, never concatenated.
- Test confirms injection payload `"1 OR 1=1"` stays in `params`, not in `text`.

**3. Password hashing — FIXED**
- Old: a weak additive hash `hash = (hash << 5) - hash + password.charCodeAt(i);` — removed.
- New: `crypto.scryptSync(password, salt, 64)` — industry-standard KDF.
  - 16-byte random salt per password (unique per call, verified by test).
  - 64-byte derived key.
  - Format: `saltHex:hashHex` — no plaintext in output.
- Verification uses `crypto.timingSafeEqual` — resistant to timing attacks.
- Input validation: empty/non-string password throws or returns `false`.

**4. Tests — ✅ All passing**
- `tests/auth.test.js` (6 tests): hashPassword format/randomness/throwing, verifyPassword correct/wrong/malformed, login success/failure/edge cases.
- `tests/users.test.js` (6 tests): createUser stores hash not plaintext, rejects missing fields, missing body, deleteUser parameterized query + injection payload isolation, listUsers returns array.

**5. Residual code concerns (not in scope, noted for awareness)**
- `getUser()` still returns hardcoded user map — not modified, not a regression.
- `validateEmail()` still uses weak `indexOf("@") > 0` — not modified, not a regression.
- `deleteUser()` returns the query object instead of executing it — acceptable for a stub/prototype; the SQL injection fix is structurally correct regardless.

---

### Verdict: **APPROVED**

No blockers. All three security objectives are met. The implementation is clean, well-documented, and fully tested.

---