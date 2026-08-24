# Evaluator references

This file is for maintaining the suite, not for coding agents. Prepared task workspaces contain only the source tree at the seed commit and do not include this file, the source remote, or later Git history.

The historical fixes below calibrate task feasibility and the automated checks. A candidate solution does not need to reproduce their exact diff.

| Task | Seed | Historical fix | Upstream context |
| --- | --- | --- | --- |
| LINK-01 | `91896b95e839913a94ee26178d46221806c3687e` | `f930da2e0af83938238d35ce62049bd11a824694` | Visited article-link color |
| TYPE-01 | `562c41eb510bfb060ed7f7f51eaeb9d9d584cad2` | `4f893397ff2fd634d6cf92038b2b2ab1a4e0ba63` | PR 389 |
| TYPE-02 | `2b1756d632cd08d0c92986f2892e897b55158974` | `0a02230d54277105cd298cc52892105ef8306feb` | Issue 727 / PR 728 |
| CODE-01 | `664e0d361f3993fec415016d60c656f6fef3fab5` | `2943c0d5c8d8f011be2ce8c6b80bd7044baafa32` | Nested example code background |
| HIER-01 | `9db0402b0856630c08c72aab551220f9a40775e8` | `39ebe263ca584f914ae5777b18938191f0afb627` | Article section hierarchy |
| RESP-01 | `5540ce5d365fa25a3b84be041f58de9cddf1e35b` | `048c479d9b320a8e78f8c9f770ed15a3da380040` | Issue 299 / PR 769 |
| A11Y-01 | `e6637e25b8085475c8d93eb52b73b56c3ebf2fc8` | `db91328edf41f8e88d913898ada20fd958e0dce9` | Issue 559 / PR 678 |

When upstream changes make a task stale, add a new task version with a new id or seed. Do not silently rewrite old results to use a new baseline.
