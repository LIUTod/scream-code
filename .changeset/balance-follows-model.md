---
"scream-code": patch
---

The balance in the footer belongs to the model in use.

- Switching to another model could leave the previous provider's balance on screen: activating a model right after adding it with `/config` (and logging out) changed the model without clearing the balance, so a GLM session could show the DeepSeek balance. Now every model change drops the old balance and looks up the new one; a provider with no readable balance shows none.
- TodAPI balances are shown, in US dollars, for both of its endpoints (`https://todapi.work/v1` and `https://api.todapi.lol/v1`). They come from the key's `/v1/usage`, whatever the account mode (a key quota, a subscription or the wallet); a key limited by rate only has no balance to show.
