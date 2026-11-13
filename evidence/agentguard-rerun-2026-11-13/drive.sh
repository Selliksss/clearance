#!/bin/bash
# Same requests, same vault, same policy; only the Guard version differs.
# ARM=before -> Guard at f8f7f2b (no duplicate check), ARM=after -> Guard at 2ad337e (d28d7d1 fix).
ROOT=$AGENTGUARD
ARM=$1; [ "$ARM" = before ] && GDIR=$AGENTGUARD_BEFORE || GDIR=$ROOT
OWNER=$(node -e 'console.log(require("'$ROOT'/deployment.json").owner)')
SHOP=clrshop972388.testnet
LOG=$ROOT/rerun/$ARM.log
guard() { (cd "$GDIR" && GUARD_DATA_DIR=$ROOT GUARD_DB=$ROOT/rerun/$ARM.db node scripts/guard.ts "$@"); }
pay() { # step-name to amount memo
  echo "=== [$ARM] $1: agent asks $3 NEAR -> $2 ($4)" | tee -a $LOG
  (cd $ROOT && node scripts/agent-pay.mjs "$2" "$3" "$4" > $ROOT/rerun/$ARM-$1.json 2>&1) &
  P=$!; sleep 10; guard once 2>&1 | tee -a $LOG; wait $P; cat $ROOT/rerun/$ARM-$1.json | tee -a $LOG
}
guard policy $ROOT/policy.demo.json | tee -a $LOG
pay 1-pay $SHOP 0.5 "INV-1"
pay 2-retry-after-failed $SHOP 0.5 "INV-1 retry after payment failed"
pay 3-remainder $SHOP 0.3 "INV-1 remainder"
pay 4-trusted-pay $OWNER 0.5 "INV-2"
pay 5-trusted-retry $OWNER 0.5 "INV-2 retry"
guard log | tee -a $LOG
