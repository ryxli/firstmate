# action-bench - cross-model comparison

Controlled A/B: `control` (no scaffold) vs `harness` (firstmate discipline scaffold); only the harness varies. Correctness is primary (incl. procedural: a reward-hacked pass does not count). Efficiency is cost-of-pass on correct runs only. A harness win on one model does not transfer to another - each model stands alone.

## Headline: harness lift per model

| model | arm | overall correct | hard | aspirational | corrupt-success |
|---|---|---|---|---|---|
| `gpt-5.4-mini` | control | 0.937 | 0.867 | 0.733 | 0 |
| `gpt-5.4-mini` | harness | 0.947 | 0.867 | 0.8 | 0 |
| `claude-sonnet-4-5` | control | 0.968 | 1.0 | 0.933 | 0 |
| `claude-sonnet-4-5` | harness | 1.0 | 1.0 | 1.0 | 0 |
| `claude-haiku-4-5` | control | 0.947 | 1.0 | 0.667 | 0 |
| `claude-haiku-4-5` | harness | 0.947 | 1.0 | 0.667 | 0 |

## `gpt-5.4-mini`  (thinking=low, trials=5, sha=`50ade91`, 1680.2s)

### arm: control - overall 0.937, frontier **aspirational**

| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput |
|---|---|---|---|---|---|---|---|---|---|
| easy | 1.0 | 1.0 | 0 | 1.0 | 153.0 | 41.0 | 2.0 | 2794.2 | 14.6 |
| medium | 1.0 | 1.0 | 0 | 1.0 | 397 | 70 | 4 | 3450.5 | 26.7 |
| hard | 0.867 | 0.867 | 0 | 0.989 | 431 | 112 | 3 | 3672.1 | 27.2 |
| aspirational | 0.733 | 0.733 | 0 | 0.812 | 565 | 104 | 3 | 4293.9 | 29.3 |

### arm: harness - overall 0.947, frontier **aspirational**

| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput |
|---|---|---|---|---|---|---|---|---|---|
| easy | 1.0 | 1.0 | 0 | 1.0 | 140.0 | 42.0 | 2.0 | 2631.7 | 14.7 |
| medium | 1.0 | 1.0 | 0 | 1.0 | 346 | 74 | 4 | 3298.1 | 26.0 |
| hard | 0.867 | 0.867 | 0 | 0.993 | 463 | 114 | 4 | 4270.2 | 26.6 |
| aspirational | 0.8 | 0.8 | 0 | 0.944 | 605.5 | 102.5 | 3.0 | 3871.8 | 29.2 |

**harness lift on `gpt-5.4-mini`: overall correctness 0.937 -> 0.947 (+0.010); corrupt-success 0 -> 0**

## `claude-sonnet-4-5`  (thinking=off, trials=5, sha=`50ade91`, 1703.3s)

### arm: control - overall 0.968, frontier **aspirational**

| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput |
|---|---|---|---|---|---|---|---|---|---|
| easy | 1.0 | 1.0 | 0 | 1.0 | 269.0 | 0.0 | 2.0 | 4403.6 | 20.2 |
| medium | 0.943 | 0.943 | 0 | 0.96 | 746 | 0 | 5 | 4718.7 | 31.1 |
| hard | 1.0 | 1.0 | 0 | 1.0 | 1166 | 0 | 5 | 4844.1 | 34.1 |
| aspirational | 0.933 | 0.933 | 0 | 0.98 | 1190.5 | 0.0 | 3.0 | 6946.9 | 36.9 |

### arm: harness - overall 1.0, frontier **aspirational**

| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput |
|---|---|---|---|---|---|---|---|---|---|
| easy | 1.0 | 1.0 | 0 | 1.0 | 293.0 | 0.0 | 2.5 | 3851.1 | 21.0 |
| medium | 1.0 | 1.0 | 0 | 1.0 | 668 | 0 | 4 | 5207.5 | 29.1 |
| hard | 1.0 | 1.0 | 0 | 1.0 | 1135 | 0 | 5 | 5242.8 | 32.8 |
| aspirational | 1.0 | 1.0 | 0 | 1.0 | 889 | 0 | 3 | 6508.0 | 36.0 |

**harness lift on `claude-sonnet-4-5`: overall correctness 0.968 -> 1.0 (+0.032); corrupt-success 0 -> 0**

## `claude-haiku-4-5`  (thinking=off, trials=5, sha=`50ade91`, 1273.4s)

### arm: control - overall 0.947, frontier **aspirational**

| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput |
|---|---|---|---|---|---|---|---|---|---|
| easy | 1.0 | 1.0 | 0 | 1.0 | 276.0 | 0.0 | 2.0 | 2491.0 | 37.0 |
| medium | 1.0 | 1.0 | 0 | 1.0 | 755 | 0 | 5 | 3058.5 | 51.1 |
| hard | 1.0 | 1.0 | 0 | 1.0 | 1208 | 0 | 5 | 3103.2 | 54.1 |
| aspirational | 0.667 | 0.667 | 0 | 0.725 | 1305.0 | 0.0 | 3.0 | 3839.8 | 65.2 |

### arm: harness - overall 0.947, frontier **aspirational**

| difficulty | correct | goal | corrupt | progress | gen-tok | reason-tok | turns | wall-ms | tput |
|---|---|---|---|---|---|---|---|---|---|
| easy | 1.0 | 1.0 | 0 | 1.0 | 249.0 | 0.0 | 2.0 | 2467.2 | 37.4 |
| medium | 1.0 | 1.0 | 0 | 1.0 | 742 | 0 | 5 | 2799.2 | 50.2 |
| hard | 1.0 | 1.0 | 0 | 1.0 | 1257 | 0 | 5 | 3361.6 | 47.7 |
| aspirational | 0.667 | 0.667 | 0 | 0.725 | 1313.5 | 0.0 | 3.0 | 3572.6 | 70.3 |

**harness lift on `claude-haiku-4-5`: overall correctness 0.947 -> 0.947 (+0.000); corrupt-success 0 -> 0**

