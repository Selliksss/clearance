#!/bin/bash
# The documented limit: after 10 minutes the same retry is judged on its own. Then the owner rejects the two held retries.
sleep 630
ROOT=$AGENTGUARD; cd $ROOT
source <(sed -n '/^ROOT=/,/^}/p' rerun/drive.sh | sed 's/^ARM=\$1.*/ARM=after; GDIR=$ROOT/') 2>/dev/null
ARM=after; GDIR=$ROOT; LOG=$ROOT/rerun/after.log; SHOP=clrshop972388.testnet
guard() { (cd "$GDIR" && GUARD_DATA_DIR=$ROOT GUARD_DB=$ROOT/rerun/after.db node scripts/guard.ts "$@"); }
echo "=== [after] 6-retry-11-min-later: agent asks 0.5 NEAR -> $SHOP (INV-1 retry, 11 minutes later)" | tee -a $LOG
(node scripts/agent-pay.mjs $SHOP 0.5 "INV-1 retry, 11 minutes later" > rerun/after-6-retry-later.json 2>&1) & P=$!
sleep 10; guard once 2>&1 | grep -v Experimental | tee -a $LOG; wait $P; cat rerun/after-6-retry-later.json | tee -a $LOG
echo "=== owner rejects the held retries #6 and #9" | tee -a $LOG
guard reject 6 2>&1 | grep -v Experimental | tee -a $LOG; guard reject 9 2>&1 | grep -v Experimental | tee -a $LOG
node rerun/chain.mjs > rerun/chain-requests.jsonl; cat rerun/chain-requests.jsonl
