# Acting as a named account (account binding)

> Part of the `agent-custody` skill. Read `SKILL.md` first. When fetched over HTTP the base is `https://skills.outlayer.ai/agent-custody/`.

## Acting as a Named Account (Account Binding)

By default the wallet acts as its own implicit account — a 64-character hex
string. **Binding** lets it act as a named account instead: spending from it
under the owner's policy, and sending email as `alice.near@near.email`.

There are two modes and they are NOT interchangeable. Pick by who owns the
account:

| | `personal_account` | `hos_lease` |
|---|---|---|
| Whose account | The user's own `alice.near` | A leased, keyless agent account (`agent.tla`) |
| Who installs the contract | The user, with one transaction you hand them | The provider, before you ever see it |
| `impl_version` in `PUT` | **REJECTED** — versioned by the account's code hash | **REQUIRED** |
| `owner_account_id` in `PUT` | Optional; if sent, must equal `asset_account_id` | Required |
| Spending limits | The owner's policy only | The owner's policy **and** an on-chain spend grant |
| Setup kit endpoint | Yes | No — answers 400 |

**A binding moves the name, not the access.** Your wallet still pays, and
everything decided about who you are for money and for secrets is decided about
the wallet's own 64-character account: spending limits, quotas, and whether a
secret's access condition admits you. A credential the owner wants you to read
must therefore name that account. Naming the bound account instead
(`alice.near`) looks right and admits nothing.

### Binding a user's own account

**Step 1.** Record it. This returns the `executor_account_id` the user is about
to authorize. It authorizes nothing by itself: `binding_status` stays `pending`
until that executor is actually in the account's extension set.

```bash
curl -s -X PUT -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"asset_account_id":"alice.near","kind":"personal_account"}' \
  "https://api.outlayer.ai/wallet/v1/binding"
```

**Step 2.** The user signs, from their own account. You cannot do this part —
you have no key for their account and never will.

**Send them a link, not a curl command.** The dashboard has a page for exactly
this step:

> Your account is ready to bind. Open this and sign once:
> https://app.outlayer.ai/wallet/connect?key={api_key}

That page reads the pending binding with the key, shows every action in the
transaction before anything is signed, refuses to continue if the connected
wallet is not the account being bound, and links to the policy editor once it
goes active. Prefer it for anyone who is not going to run `near` themselves.

If they would rather use the CLI, the same kit is behind:

```bash
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/binding/setup?kind=personal_account"
```

A `409` here means the account already runs a contract. **Do not try to work
around it** — deploying over an existing contract does not clear its state, and
the usual victim is the user's own 2FA/multisig wallet. Ask for a different
account.

Tell the user the cost honestly: installation references a network-wide global
contract by hash, so they never pay to store the code. Their transaction costs
a little state, two 1-yoctoNEAR markers and gas — well under 0.1 NEAR.

**Step 3.** Poll `GET /wallet/v1/binding` until `binding_status` is `active`.

### Two accounts, two sets of endpoints

A bound wallet has **two** NEAR accounts, and they hold different money. Get
this wrong and you will read one balance and try to spend the other.

| | the wallet's own account | the bound account |
|---|---|---|
| what it holds | gas, and anything you sent it | the user's money — the point of binding |
| read balance | `GET /wallet/v1/balance` | `GET /wallet/v1/binding/balance` |
| spend | `POST /wallet/v1/transfer`, `/withdraw`, `/swap` | `POST /wallet/v1/binding/transfer` |
| intents balances | here, always | never — deposits credit the signer |

One rule covers all of it: **everything under `/wallet/v1/binding/` is the
bound account; everything else is the wallet itself.** No flags, no defaults
that change once a binding activates.

```bash
# What does the user's account hold?
curl -s -H "Authorization: Bearer $API_KEY" \
  "https://api.outlayer.ai/wallet/v1/binding/balance?token=usdc.near"

# Send 5 USDC from it. `to` is the RECIPIENT, not the token contract.
curl -s -X POST -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"to":"bob.near","amount":"5000000","token":"usdc.near"}' \
  "https://api.outlayer.ai/wallet/v1/binding/transfer"
```

`/binding/transfer` is a shortcut, not a loophole: it builds exactly the
`w_execute_extension` you could post yourself, and the same policy, pre-flight,
spend-grant and approval rules apply. Use it unless you need something it does
not express.

### Running under the binding

For anything `/binding/transfer` does not cover, call `w_execute_extension` on
the account via `POST /wallet/v1/call`. Everything inside that call is decoded
and checked against the owner's policy — every recipient, every amount, every
refund destination — before anything is signed.

Rules that will refuse you outright, whatever the policy says:

- **Never** put `internal` operations in the request (`add_extension`,
  `remove_extension`, `set_signature_mode`). That is rewiring the account, not
  spending from it, and it is denied with no way to opt in.
- Anything the decoder cannot state is denied: `ft_transfer_call`, unknown
  methods, mangled arguments. Use plain `ft_transfer` / `nft_transfer`.
- Under `hos_lease` the grant is stricter still: a call must stand alone in its
  promise, carry exactly 1 yoctoNEAR, set no `refund_to`, and name no
  `approval_id`.

Read the outcome from `result.promises[]`, not from the status alone — see
"Reading Transaction Statuses" in `SKILL.md` for `partially_failed`.

### Acting under the user's name

By default your calls run under **your own** name: a WASI guest sees
`NEAR_SENDER_ID` = your wallet account, exactly as before any binding existed.
That is deliberate — a binding gives you a capability, it does not silently
rename you, because projects derive real things from that name (a mail project
turns it into the mailbox it sends from).

When you want the user's name, ask for it per call:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -H "X-Payment-Key: $PAYMENT_KEY" \
  -d '{"input":{"operation":"send", ...}, "use_bound_identity": true}' \
  "https://api.outlayer.ai/call/<owner>/<project>"
```

The binding must be `active`; the worker re-checks it against the chain inside
the TEE and refuses the job if the chain disagrees. Billing never follows it —
the call is still paid by your key.

**The flag is enough on its own.** Do not add `X-Wallet-Id`: the wallet is taken
from the credential you already sent. (A period in 2026-08 required that header
by accident, so older integrations carry it; sending your own wallet's id is
harmless, sending anyone else's is refused as `wallet_not_yours`.)

**It works on the on-chain door too, and that is the point.** `request_execution`
takes the same flag in `params`, so one module gives the same answer about who
it is whether it was started by an HTTPS call or by a transaction:

```jsonc
// params of request_execution
{ "attached_usd": "10000", "use_bound_identity": true }
```

On that door the binding is matched by the **caller of the transaction**, which
is your wallet's own implicit account — so the transaction has to be sent by the
wallet, through `POST /wallet/v1/call`, not from a personal keychain. A
transaction signed by some other account of yours finds no binding.

Asked for and unavailable is a **refusal**, never a quiet fallback: a request
that named a bound identity is never run under your own name instead. You get a
failed job with the reason rather than mail sent from the wrong address.

### Tell the user what the policy is for

On a **personal_account** binding, the owner's policy is the **only** limit on
what you can spend. There is no on-chain grant behind it as there is for
`hos_lease`. A binding with no policy means you can move everything in that
account, which is almost never what the user pictured when they clicked sign.

So when a user binds their own account, say so and offer the fix:

> Your account is bound and I can now spend from it. Right now there is no
> limit on that beyond the balance itself. If you want one — a daily cap, a
> list of addresses I may send to, or approval required above some amount —
> set a policy here: https://app.outlayer.ai/wallet?key={api_key}

Do not wait to be asked. You are the party that benefits from the limit being
absent, so you are the party that has to raise it.

**Then tell them what a policy on a BOUND wallet has to contain, because the
obvious one kills your access entirely.** Spending from a bound account goes
through a single contract call (`w_execute_extension`) on the account itself,
and after the contents of that call are checked against the rules, the call
itself faces them too. So a policy governing a bound wallet must, on top of
whatever limits the user wants:

- list `call` in `transaction_types` — a policy of `["transfer"]` says exactly
  what the user means and refuses the only route that does it;
- list **the bound account itself** in the address rules (or use
  `mode: "none"`) — the call goes *through* that account, so a whitelist of
  payees alone refuses everything;
- allow `native` in `allowed_tokens` (or `"*"`) — a call is denominated in NEAR
  whatever token moves inside it, so a list of one stablecoin stops native sends.

Whatever NEAR that outer call attaches is metered against the native limits like
any other spend; only the 1-yoctoNEAR marker a payable method demands is left
out, because it proves key ownership rather than paying anyone.

A refusal tells you which of the three it was, and that the OUTER destination of
the call is judged as well as its contents. So do not read
`Address 'alice.near' is not in whitelist` as the user having mis-listed a payee:
when you aimed the call at their bound account — which is what spending from a
bound wallet is — the name in that refusal IS the bound account, and it belongs
in the address rules alongside the payees. (If you aimed an extension call
somewhere else, the name is that other contract, and adding it to a whitelist is
a real decision about a third party, not a formality.)

### Keeping it alive

- The **executor** pays gas for every call. Watch `gas_balance_low` in
  `GET /wallet/v1/binding` and top the executor up before it stops — that
  read is the only notification, there is no low-gas webhook.
- The user can end it at any time by removing the executor from their extension
  set — one transaction, no permission from OutLayer. Your next call is refused.
- `DELETE /wallet/v1/binding` ends OutLayer's side and cancels approvals still
  waiting on that account.
