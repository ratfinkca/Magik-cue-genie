# Schema Versioning

Magik-cue-genie currently writes `schema_version: 1` in per-track sidecars and aggregate `report.json` files.

The goal of schema versioning is to keep generated files stable enough for tests, review workflows, and future UI/export tooling while still allowing small additive improvements.

## Schema Version 1 Compatibility

The following changes are allowed within `schema_version: 1` because consumers should be able to keep reading existing required fields:

- Adding new cue labels, such as future labels from the documented cue vocabulary.
- Adding new warning strings.
- Adding new `analysis_settings` fields in aggregate `report.json`.
- Adding new top-level aggregate report metadata when it is backwards-compatible and existing keys keep their meaning.
- Adding optional fields that consumers can safely ignore, provided existing required fields and types remain unchanged.
- Adding optional analysis metadata such as confidence/source fields or diagnostic debug objects for an existing estimate.
- Adding optional cue `metadata` fields for machine-readable heuristic details.

For schema version 1, readers should preserve and use known fields, and ignore unknown optional fields.

## Changes Requiring Schema Version 2

The following changes should require `schema_version: 2`:

- Changing or removing existing required fields.
- Changing the required keys of cue objects.
- Changing the type of an existing field.
- Changing the per-track sidecar top-level shape in a way that breaks existing consumers.
- Reinterpreting an existing field so its meaning is no longer compatible with schema version 1.

## Optional Cue Metadata

Optional cue metadata is allowed in schema version 1 because consumers are expected to ignore unknown optional cue fields.

If cue metadata becomes required, changes the meaning of existing cue fields, or consumers cannot safely ignore it, defer that change to `schema_version: 2`.

Cue objects should continue to include the stable required keys:

```json
{
  "label": "energy_shift",
  "time_seconds": 1.0,
  "confidence": 0.25,
  "reason": "Heuristic: notable RMS energy rise; not beat- or phrase-aware.",
  "metadata": {
    "heuristic": "rms_energy_shift",
    "direction": "rise",
    "delta": 0.75
  }
}
```
