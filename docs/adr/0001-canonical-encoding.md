# ADR 0001: Canonical authorization commitment encoding

Status: Accepted
Date: 2026-08-11
Phase: 01
Supersedes: none

## Context

The Signet extension signs exactly one XRPL Payment per lawful obligation. Everything that can
change the meaning of that payment must be bound into a single value that the contracts, the
extension and the verifier all compute identically. PRD section 13 lists the fields; it does not
specify the bytes. This ADR specifies the bytes and freezes them.

Three languages must agree: TypeScript for the reference model and verifier, Go for the extension,
Solidity for the on-chain action verifier. A field-boundary ambiguity that any one of them resolves
differently is a signature over a different payment than the other two believe was authorized.

## Decision

Two distinct commitments exist, with separate domain separators. They are never interchangeable.

### Obligation hash

Identifies *which* obligation and generation a decision concerns. It is emitted on refusals too,
where most authorization fields do not exist and inventing them would be dishonest.

```text
keccak256(
  keccak256("SIGNET_FASSETS_OBLIGATION_V1")   32 bytes
  schemaVersion                                1 byte
  flareChainId                                32 bytes, big-endian
  assetManager                                20 bytes
  agentVault                                  20 bytes
  requestId                                   32 bytes, big-endian
  requestGeneration                            4 bytes, big-endian
)
```

Preimage length: exactly 141 bytes.

### Authorization commitment

Covers the complete signed payment. Emitted only when the decision authorizes.

```text
keccak256(
  keccak256("SIGNET_FASSETS_REDEMPTION_V1")   32 bytes
  schemaVersion                                1 byte
  flareChainId                                32 bytes
  instructionSender                           20 bytes
  assetManager                                20 bytes
  agentVault                                  20 bytes
  requestId                                   32 bytes
  requestGeneration                            4 bytes
  xrplNetworkId                                4 bytes
  xrplSourceAccountId                         20 bytes
  xrplSourceAddressStringHash                 32 bytes
  destinationAccountId                        20 bytes
  destinationAddressStringHash                32 bytes
  destinationTagMode                           1 byte
  destinationTag                               4 bytes
  amountDrops                                  8 bytes
  paymentReference                            32 bytes
  firstUnderlyingBlock                         8 bytes
  lastUnderlyingBlock                          8 bytes
  lastUnderlyingTimestamp                      8 bytes
  sequenceMode                                 1 byte
  sequenceOrTicket                             4 bytes
  lastLedgerSequence                           4 bytes
  feeDrops                                     8 bytes
  maxFeeDrops                                  8 bytes
  policyVersion                                4 bytes
  extensionId                                 32 bytes
  extensionCodeHash                           32 bytes
)
```

Preimage length: exactly 431 bytes.

## Rationale for each rule

**Fixed width, no length prefixes, no variable-length members.** Every field occupies a constant
number of bytes, so there is exactly one preimage per input and no way to shift a boundary between
two adjacent fields. This is what rules out the classic packed-encoding collision, where making one
field longer and the next shorter yields the same bytes. The encoder asserts the total length, so a
field added or resized without updating the constant fails immediately rather than producing a
quietly different commitment.

**Big-endian everywhere.** Solidity, the EVM and XRPL binary serialisation are all big-endian. One
endianness across the whole system removes a class of cross-language bug that unit tests in a single
language cannot see.

**Overflow throws, never truncates.** `uintBE` rejects a value that does not fit its width. A
truncating encoder would silently commit to a different amount, sequence or tag than the caller
intended, which is precisely the mutation the commitment exists to detect.

**Addresses are bound twice: as a 20-byte AccountID and as the keccak of the exact string.** FAssets
records the destination as a free-form string, and the ledger indexes a 20-byte AccountID. Binding
only the string would let any difference in how Signet, XRPL and FDC normalise it become an attack
surface. Binding only the AccountID would lose the connection to the exact value FAssets recorded.
Binding both means a payment is authorized only when the decoded and literal forms both match, and
the decode itself validates the base58check checksum, so a corrupted destination cannot get this far.

**`destinationTagMode` is a separate byte from `destinationTag`.** "No tag" and "tag 0" are
different obligations, and XRPL treats a present-but-zero tag differently from an absent one. A
single field cannot express both without a sentinel, and every sentinel choice is a collision
waiting to happen. The encoder additionally rejects a non-zero tag when the mode is `NONE`, so the
untagged case has exactly one encoding.

**`sequenceMode` is a separate byte from `sequenceOrTicket`.** Sequence 91 and Ticket 91 are
different allocations that must not share a commitment.

**Both the actual fee and the fee ceiling are bound.** PRD section 13's conceptual field list names
only `maxFeeDrops`, and the fee is reported in the authorized output rather than the commitment. That
would leave the commitment describing a *family* of transactions differing in fee rather than one
transaction. No funds are at risk, because the fee is bounded by the committed ceiling and the two
variants compete for the same sequence so at most one can validate. What is lost is the verifier's
1:1 linkage from commitment to transaction hash, which PRD G5 depends on. Binding the actual fee
costs eight bytes and removes the malleability, so the encoding binds both. This is a deliberate
strengthening of section 13's conceptual list, which explicitly delegates the binary encoding to
this ADR.

**`schemaVersion` is inside the preimage, not only in the domain string.** The domain string pins
the semantic version of the whole scheme; the byte pins the version of this particular instruction.
Both are checked, and an unsupported value fails closed rather than being interpreted.

**Two domains, not one with a discriminator byte.** A refusal receipt and an authorization must not
be confusable even under a hash collision on the payload, so they start from unrelated 32-byte
constants derived from distinct strings.

## Consequences

- The encoding is frozen. Adding, removing, resizing or reordering a field is a new schema version
  and a new domain string, not an edit to this one.
- `reference/test/encoding.test.ts` mutates each of the 27 authorization fields individually and
  asserts every mutation produces a distinct commitment, and asserts that the mutation list covers
  every field of the input type, so a newly added field cannot go untested.
- `reference/test/property/decide.property.test.ts` additionally proves the *decision* threads each
  field into the encoder, which the encoding suite alone cannot show: a swapped assignment inside
  `decide` would produce a commitment that fails to move when its input moves.
- The Go extension and the Solidity verifier must consume
  `reference/test-vectors/decision-fixtures.json` rather than reimplement this scheme from the
  prose above. Two implementations by the same author that agree prove nothing about correctness.

## Alternatives rejected

**ABI encoding of a struct.** Convenient in Solidity, but it is a 32-byte-word format that would
inflate the preimage roughly threefold and would still need a hand-written Go equivalent. It also
hides the field widths that this scheme makes explicit.

**EIP-712.** Designed for wallet-displayed human-readable signing, which is not the use case; the
signer here is an enclave following policy, not a person reading a prompt. It also drags in a
typed-data hashing scheme that Go and TypeScript would each need a dependency for.

**Binding the destination as a length-prefixed string.** Reintroduces variable-length members and
therefore boundary ambiguity, for no benefit over binding the keccak of the same bytes.
