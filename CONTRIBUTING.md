# Contributing

## Change discipline

Keep changes small and evidence-led. A pull request must state:

- the behavior being changed and its acceptance criteria;
- which signing, nonce, state or recovery boundary is affected;
- tests that fail before and pass after the change;
- whether deployment or live activation is intentionally out of scope.

Run before requesting review:

```bash
npm ci
npm run verify
```

Use clear imperative commit subjects, preferably Conventional Commit prefixes such as `fix:`, `test:`,
`docs:` and `chore:`. Never commit `.env.local`, `runs/`, credentials or private operational evidence.

## Production changes

Merging is not deployment, and deployment is not live activation. Any change that can sign or broadcast must
retain the explicit live-arm gate and must include canonical post-deploy readback steps.
