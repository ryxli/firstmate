# action-bench - cross-model comparison

Controlled A/B: `control` (no scaffold) vs `harness` (firstmate discipline scaffold); only the harness varies. Correctness is primary (incl. procedural: a reward-hacked pass does not count). Efficiency is cost-of-pass on correct runs only. A harness win on one model does not transfer to another - each model stands alone.

## Headline: harness lift per model

| model | arm | overall correct | hard | aspirational | corrupt-success |
|---|---|---|---|---|---|
| `claude-sonnet-4-5` | control | 0.988 | 1.0 | 1.0 | 0 |
| `claude-sonnet-4-5` | harness | 1.0 | 1.0 | 1.0 | 0 |
| `claude-haiku-4-5` | control | 0.929 | 1.0 | 0.778 | 0 |
| `claude-haiku-4-5` | harness | 0.952 | 1.0 | 0.852 | 0 |

## `claude-sonnet-4-5`  (thinking=off, trials=3, sha=`2a59d55`, 3846.6s)

### arm: control - overall 0.988, frontier **aspirational**

| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput |
|---|---|---|---|---|---|---|---|---|---|
| easy | 1.0 | 1.0 | 0 | 1.0 | 296.5 | 0.0 | 3.0 | 2993.9 | 28.4 |
| medium | 0.963 | 0.963 | 0 | 0.974 | 711.0 | 0.0 | 4.0 | 3882.2 | 36.9 |
| hard | 1.0 | 1.0 | 0 | 1.0 | 1482.5 | 0.0 | 5.0 | 4930.0 | 43.5 |
| aspirational | 1.0 | 1.0 | 0 | 1.0 | 2136 | 0 | 6 | 5755.6 | 45.3 |

### arm: harness - overall 1.0, frontier **aspirational**

| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput |
|---|---|---|---|---|---|---|---|---|---|
| easy | 1.0 | 1.0 | 0 | 1.0 | 262.0 | 0.0 | 2.0 | 3016.0 | 26.8 |
| medium | 1.0 | 1.0 | 0 | 1.0 | 671 | 0 | 4 | 4259.0 | 35.3 |
| hard | 1.0 | 1.0 | 0 | 1.0 | 1298.0 | 0.0 | 4.5 | 4950.7 | 42.2 |
| aspirational | 1.0 | 1.0 | 0 | 1.0 | 2538 | 0 | 6 | 5911.9 | 45.4 |

**harness lift on `claude-sonnet-4-5`: overall correctness 0.988 -> 1.0 (+0.012); corrupt-success 0 -> 0**

## `claude-haiku-4-5`  (thinking=off, trials=3, sha=`2a59d55`, 2581.6s)

### arm: control - overall 0.929, frontier **aspirational**

| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput |
|---|---|---|---|---|---|---|---|---|---|
| easy | 1.0 | 1.0 | 0 | 1.0 | 299.5 | 0.0 | 2.5 | 1986.2 | 48.5 |
| medium | 1.0 | 1.0 | 0 | 1.0 | 779 | 0 | 5 | 2337.8 | 72.1 |
| hard | 1.0 | 1.0 | 0 | 1.0 | 1282.0 | 0.0 | 5.0 | 2726.8 | 71.1 |
| aspirational | 0.778 | 0.778 | 0 | 0.905 | 2478 | 0 | 7 | 3172.2 | 84.8 |

### arm: harness - overall 0.952, frontier **aspirational**

| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput |
|---|---|---|---|---|---|---|---|---|---|
| easy | 1.0 | 1.0 | 0 | 1.0 | 324.5 | 0.0 | 3.0 | 1935.8 | 49.3 |
| medium | 1.0 | 1.0 | 0 | 1.0 | 875 | 0 | 4 | 2440.2 | 65.0 |
| hard | 1.0 | 1.0 | 0 | 1.0 | 1482.5 | 0.0 | 5.0 | 2628.3 | 67.7 |
| aspirational | 0.852 | 0.852 | 0 | 0.935 | 2428 | 0 | 7 | 3324.2 | 80.0 |

**harness lift on `claude-haiku-4-5`: overall correctness 0.929 -> 0.952 (+0.023); corrupt-success 0 -> 0**

