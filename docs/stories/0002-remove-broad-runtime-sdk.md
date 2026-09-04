# Story set 0002: Remove the broad runtime SDK

## Story 1 - Preserve numerical behavior

Acceptance: pool id, TickMath, BUY/SELL single-sided liquidity, position composition and removal minimums
match fixed vectors produced by `@uniswap/v4-sdk@2.3.3`.

## Story 2 - Preserve transaction bytes

Acceptance: mint, increase and remove calldata byte lengths and keccak256 hashes match the SDK vectors; invalid
ranges, invalid sides and ambiguous mint/increase options fail closed.

## Story 3 - Remove the production dependency surface

Acceptance: a clean `npm ci` succeeds without either Uniswap SDK package; `npm ls --omit=dev --all` contains
only the reviewed `viem` tree; production audit and dependency review fail on high or critical findings.

## Story 4 - Prove the chain boundary without broadcasting

Acceptance: the migrated executable returns the same canonical status and a full-removal calldata `eth_call`
succeeds against the configured PositionManager. No signing, transaction broadcast, deployment or timer change
is part of this story.
