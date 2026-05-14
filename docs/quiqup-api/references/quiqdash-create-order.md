# Quiqdash-V3 — Create-Order canonical reference

Source of truth: the live Quiqdash-V3 frontend at
`/Users/svetoslavdimitrov/Documents/Quiqdash-v3`. Every claim here cites
`file:line` so it can be audited against the running code.

This is what Quiqdash actually sends. It supersedes the older
`lastmile.md` notes wherever the two disagree (notable disagreements
flagged inline).

---

## Endpoint

Quiqdash does **not** call the public Last-Mile API directly. It calls its
own **platform-api** endpoint, which translates and forwards upstream:

```
POST /quiqdash/orders   →   on the platform-api host
```

[`app/hooks/order/use-create-order.tsx:16`](../../../Quiqdash-v3/app/hooks/order/use-create-order.tsx)

The OpenAPI spec types this operation as
[`POST:quiqdash_api.CreateOrderRaw`](../../../Quiqdash-v3/app/lib/api/v1.d.ts#L15884) — the body is `requestBody?: never` because
the backend accepts an opaque "raw" shape. The **frontend Zod schema** is
the only authoritative description of that shape.

> ⚠️ This means the MCP server's `create_lastmile_order` (which targets
> `POST /orders` on the *public* last-mile API at `api-ae.quiqup.com`)
> sends to a **different endpoint** than Quiqdash. The two endpoints
> accept overlapping but not identical shapes — the
> Quiqdash → `/quiqdash/orders` backend normalizes the shape before
> forwarding upstream. Treat this doc as the **merchant-intent shape**;
> treat `lastmile.md` as the **public-API shape** (with some out-of-date
> fields, see "Disagreements" below).

---

## Pre-flight endpoints (in roughly the order Quiqdash fires them)

| When | Method + Path | Purpose | Source |
|---|---|---|---|
| Session boot | `GET /quiqdash/init` | Bootstrap session/feature flags | (referenced in hook catalog) |
| Page mount | `GET /me` | Current user | [`use-account.tsx:151`](../../../Quiqdash-v3/app/hooks/account/use-account.tsx#L151) |
| Page mount | `GET /account` | Account object — drives `is_fulfillment_account` branch | [`use-account.tsx:23`](../../../Quiqdash-v3/app/hooks/account/use-account.tsx#L23) |
| Page mount | `GET /accounts/{id}/capabilities` | Carrier/feature capabilities | [`use-account.tsx:100`](../../../Quiqdash-v3/app/hooks/account/use-account.tsx#L100) |
| Page mount | `GET /accounts/{id}/addresses` | Saved origin addresses (for the "Pickup from" dropdown) | [`use-addresses.tsx:8`](../../../Quiqdash-v3/app/hooks/addresses/use-addresses.tsx#L8) |
| Page mount | `GET /quiqup/service-kinds` | List of valid `service_kind` values for this partner | [`use-account.tsx:114`](../../../Quiqdash-v3/app/hooks/account/use-account.tsx#L114) |
| Page mount | `GET /countries` → `…/states` → `…/cities` | Geographical dropdowns | [`use-countries.tsx:7`](../../../Quiqdash-v3/app/hooks/data/use-countries.tsx#L7), `use-states.tsx`, `use-cities.tsx` |
| International / B2B | `GET /shipments/carriers/capabilities` | Carrier picker options | (referenced in hook catalog) |
| Optional, before create | `POST /partner/addresses` | Save new origin address (when `should_save_location && saved_location === "other location"`) — fires **before** the order POST | [`use-addresses.tsx:23`](../../../Quiqdash-v3/app/hooks/addresses/use-addresses.tsx#L23), [`page.tsx:147-160`](../../../Quiqdash-v3/app/routes/create-order/page.tsx#L147) |
| **Submit** | `POST /quiqdash/orders` | The order create itself | [`use-create-order.tsx:16`](../../../Quiqdash-v3/app/hooks/order/use-create-order.tsx#L16) |

There is **no separate geocode, zone-lookup, or capacity pre-flight**
on the standard delivery path. Coordinates come from whatever picker the
user used (saved address, geolocation, manual) and are passed inline.

---

## Validation rules (Zod `superRefine` block)

[`app/routes/create-order/utils.ts:144-509`](../../../Quiqdash-v3/app/routes/create-order/utils.ts#L144)

**Origin** (required only when `saved_location === "other location"`, i.e. a brand-new pickup):
- `address.address1` non-empty
- `address.town` non-empty (becomes the area / locality)
- `address.country` non-empty
- `emirate` non-empty
- `contact_name` non-empty
- `contact_phone` non-empty

**Destination** (always required):
- Same six fields as origin
- `contact_email` required only when origin country **is not** `"AE"` (i.e. international)

**Payment cross-field rule:**
- `payment_mode === "paid_on_delivery"` ⇒ `payment_amount > 0` ([utils.ts:260](../../../Quiqdash-v3/app/routes/create-order/utils.ts#L260))
- `payment_mode === "pre_paid"` ⇒ `payment_amount` may be 0 (no upper-bound check)
- The enum at the form level only allows **two values**: `"pre_paid" | "paid_on_delivery"` ([utils.ts:83](../../../Quiqdash-v3/app/routes/create-order/utils.ts#L83)). The older `lastmile.md` doc lists four (`pre_paid | paid_on_delivery | cash_on_delivery | card_on_delivery`) — Quiqdash collapses to two. **For LLM use, only emit the two.**

**Items** (every entry):
- `name` non-empty
- `quantity >= 1`
- `weight / length / width / height >= 0` (negative blocked by schema)

**Products** (international + fulfilment):
- `description` non-empty
- `sku` required iff `is_fulfillment === true`; otherwise auto-filled as `DEFAULT-<uuid>` in the transform ([utils.ts:579](../../../Quiqdash-v3/app/routes/create-order/utils.ts#L579))
- `quantity` in `[1, 10000]`
- `selling_price > 0` (non-B2B); range `(0, 9999]`
- `country_of_origin` non-empty (non-B2B)

**Service kind:**
- `service_kind` non-empty when `order_type === "delivery"`

**Logistics (carrier / incoterm):**
- `carrier` required when origin is non-UAE OR international OR B2B
- `incoterm` required when international (auto-defaulted to `"DDU"` when origin country is `"SA"` and incoterm blank, [utils.ts:575](../../../Quiqdash-v3/app/routes/create-order/utils.ts#L575))

**B2B appointment** (optional; if any of date/fromTime/toTime is set, all must be):
- `date >= today`
- `toTime > fromTime`
- Window duration `>= 60` minutes

---

## Final payload sent to `POST /quiqdash/orders`

The Zod `.transform(...)` block ([utils.ts:511-612](../../../Quiqdash-v3/app/routes/create-order/utils.ts#L511)) does the last mile of shape-building. Key transforms:

- **`city` is duplicated from `town`** on both origin and destination
  addresses ([utils.ts:52, 69](../../../Quiqdash-v3/app/routes/create-order/utils.ts#L52)). The backend gets both.
- **`coordinates` is dropped** when it matches `DEFAULT_COORDINATES` (placeholder lat/lng), so the backend never receives sentinel coords.
- **Items are expanded by `firstItem.quantity`** — if the user enters one
  item with `quantity: 3`, the array sent is `[item, item, item]`
  (3 copies, each keeping `quantity: 3` in the payload). The
  `/quiqdash/orders` backend further normalizes this to "one parcel
  per item with quantity 1" upstream.
- **`kind` is copied from `service_kind`** ([utils.ts:602](../../../Quiqdash-v3/app/routes/create-order/utils.ts#L602)).
- **`partner_order_id` is copied from the first item's `name`** ([utils.ts:603](../../../Quiqdash-v3/app/routes/create-order/utils.ts#L603)) — this is the merchant's external reference and lands on the order. Surprising default, but it's what Quiqdash does.
- **Return orders swap `origin` ↔ `destination`** and force
  `service_kind = "partner_return"`, `payment_mode = "pre_paid"`, `payment_amount = 0` ([utils.ts:535-572](../../../Quiqdash-v3/app/routes/create-order/utils.ts#L535)).
- **`mirsal2_code` is removed and re-emitted as `registration_numbers: [{type_code, value, issuer_country_code}]`** when present (customs declarations for international orders above threshold).

### Annotated example (delivery, pre-paid, domestic UAE)

```jsonc
{
  // form-level metadata
  "order_type": "delivery",                    // "delivery" | "return"
  "saved_location": "other location",          // either a saved-address id or "other location"
  "should_save_location": false,
  "is_outside_regions": false,
  "is_fulfillment": false,
  "ready_for_collection": true,                // true = create + dispatch; false = save as draft

  // service classification
  "service_kind": "partner_same_day",          // one of /quiqup/service-kinds for this partner
  "kind": "partner_same_day",                  // == service_kind, set by transform
  "service_price": 0,                          // pricing — populated by Quiqdash's quote logic, may be 0
  "scheduled_for": "2026-05-14T09:00:00+04:00", // optional ISO datetime
  "partner_order_id": "MCP eval probe",        // == items[0].name, set by transform

  // payment
  "payment_mode": "pre_paid",                  // "pre_paid" | "paid_on_delivery"
  "payment_amount": 0,                         // number — must be > 0 when payment_mode = paid_on_delivery

  // origin
  "origin": {
    "address": {
      "address1": "Test Street 1, Test Area",
      "address2": "Test Building",
      "town": "Dubai",                         // user-visible "area"
      "city": "Dubai",                         // == town (transform-copied)
      "country": "AE",                         // ISO-2 (NOT "UAE" — see Disagreements)
      "ksa_national_address": null,            // only when country = "SA"
      "coordinates": { "lat": 25.2048, "lng": 55.2708 }   // omitted if default sentinel
    },
    "emirate": "Dubai",                        // required separately from town
    "contact_name": "Test Merchant",
    "contact_phone": "+971500000000",
    "notes": ""
  },

  // destination — same shape minus ksa_national_address, plus contact_email & postcode
  "destination": {
    "address": {
      "address1": "Test Building, Test Street 1, Test Area",
      "address2": "",
      "town": "Dubai",
      "city": "Dubai",
      "country": "AE",
      "postcode": null,
      "ksa_national_address": null
    },
    "emirate": "Dubai",
    "contact_name": "Test Customer",
    "contact_phone": "+971500000000",
    "contact_email": "",                       // required when origin country ≠ "AE"
    "notes": ""
  },

  // items — array length = firstItem.quantity (parcel-expansion transform)
  "items": [
    {
      "name": "MCP eval probe",
      "dimensions": { "length": 10, "width": 10, "height": 10 },
      "weight": 0.5,
      "quantity": 1
    }
  ],

  // products — used for international + fulfilment; omit for domestic UAE
  "products": [],

  // logistics — empty for domestic UAE; required for international/B2B
  "carrier": "",
  "incoterm": "",

  // B2B
  "exclude_packing_list": false,
  "appointment": undefined,                    // present only for B2B

  // transform-added constants
  "required_docs": [],                         // always [] in current code
  "source": "Quiqdash",                        // const
  "metadata": {},                              // const
  "notes": "",                                 // const — note this is at root, separate from origin/destination.notes

  // optional, only when mirsal2_code was set
  "registration_numbers": [
    { "type_code": "MIRSAL2", "value": "...", "issuer_country_code": "AE" }
  ]
}
```

---

## Disagreements with `lastmile.md` (the older Stoplight-derived doc)

| Field | `lastmile.md` claims | Quiqdash actually sends | Likely source of truth |
|---|---|---|---|
| `country` (address) | `"UAE"` (long form) | `"AE"` (ISO-2) | **Quiqdash**. The Stoplight doc looks stale. The `/quiqdash/orders` backend normalizes to whatever upstream wants. |
| `coords` shape | `coords: [lng, lat]` (array) | `coordinates: { lat, lng }` (object, key renamed) | **Quiqdash**. Both the key name (`coordinates` not `coords`) and the structure (object not array) differ. |
| `payment_mode` enum | 4 values (`pre_paid | paid_on_delivery | cash_on_delivery | card_on_delivery`) | 2 values (`pre_paid | paid_on_delivery`) | Quiqdash's two-value subset is what merchants actually emit. |
| Items shape | `{name, quantity, parcel_barcode?}` only | adds `dimensions{length,width,height}`, `weight` | Quiqdash. Public API may also accept these — `lastmile.md` was under-spec. |
| `required_documents` | named `required_documents` | named `required_docs` (transform-emitted constant `[]`) | Quiqdash uses `required_docs`. Public API may differ in name. |
| `partner_order_id` | "client's own reference" | == `items[0].name` by default | Quiqdash; merchants can override but the default is the first parcel's name. |

When in doubt for **public-API direct calls** (i.e. our MCP's
`create_lastmile_order` against `api-ae.quiqup.com`), prefer what gets a
2xx from staging. When in doubt for **describing merchant intent** to an
LLM, prefer this doc.

---

## Where Quiqdash gets these values

**`country` is hardcoded to `"AE"` or `"SA"`** — the origin country `<select>`
options are literal in [`origin-section.tsx:240-243`](../../../Quiqdash-v3/app/routes/create-order/origin-section.tsx#L240):

```tsx
options={[
  { label: "United Arab Emirates", value: "AE" },
  { label: "Saudi Arabia", value: "SA" },
]}
```

The `/countries` API is fetched but only used to populate the
**destination** picker for international orders. The origin's ISO-2
string ships straight through to the payload — Quiqdash never asks any
endpoint what the canonical code should be.

**`coordinates` come from Google Places Autocomplete**
([`origin-section.tsx:128-152`](../../../Quiqdash-v3/app/routes/create-order/origin-section.tsx#L128)):

1. User types address → Google Maps Places returns a `PlaceResult` →
   `place.geometry.location.lat()/lng()` is read and set on the form.
2. User may further drag a map pin (`handleCoordinatesChange`).
3. `DEFAULT_COORDINATES` / `DEFAULT_COORDINATES_SA` are used as
   placeholders before user input — the Zod transform drops them at
   submit so the backend never receives sentinel values.

Shape: always `{lat: number, lng: number}` — never the GeoJSON
`[lng, lat]` array form. This is the **Quiqdash-side** shape; whether
the `/quiqdash/orders` backend reshapes for upstream is unknown.

---

## `required_docs` semantics

The field is **not** purely vestigial — it controls **whether the
courier must collect a document at delivery**:

- `["customer_identification_photo"]` → driver asked to capture the
  customer's Emirates ID at handover.
- `["otp"]` → delivery gated behind an OTP exchange.
- `[]` (current Quiqdash default for both delivery and return paths)
  → no document collection.

The current frontend always emits `[]` because the UI doesn't expose
the option, but **the backend honors non-empty values** at runtime.
Treat the empty array as a deliberate "no extra collection" signal,
not a vestige.

---

## Item-expansion-by-quantity — what's going on

[`utils.ts:514-519`](../../../Quiqdash-v3/app/routes/create-order/utils.ts#L514):

```ts
const firstItem = data.items[0];
const expandedItems = Array(firstItem.quantity)
  .fill(null)
  .map(() => ({ ...firstItem }));
```

If the user types one item with `quantity: 3`, the array sent to the
backend is **three copies of that item, each still carrying
`quantity: 3`**. Worth knowing because:

- The backend likely cares about **array length** (one entry per
  parcel/AWB), not `quantity` inside each entry — otherwise it'd see
  9 parcels (3 × 3).
- Direct callers (like our MCP `create_lastmile_order`) replicating
  Quiqdash's shape need to **expand items the same way**, not just
  emit `[{name, quantity: 3}]`.
- Conversely, if our MCP hits the public `/orders` (not
  `/quiqdash/orders`), the public API may follow `lastmile.md`'s
  convention of `quantity: 1` per array entry — different rule.

Untested whether the `/quiqdash/orders` backend would accept the
unexpanded form. If correctness becomes a question, probe with both
shapes against staging.
