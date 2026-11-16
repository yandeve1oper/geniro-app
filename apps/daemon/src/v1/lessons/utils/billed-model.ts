function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The model a reflection was billed for, read from its `turn_complete` rows:
 * the one its cost split charged most across them, else the model a turn named
 * itself as running, else null when no turn reported either.
 */
export function billedModelOf(turnPayloads: readonly unknown[]): string | null {
  const spent = new Map<string, number>();
  let named: string | null = null;
  for (const payload of turnPayloads) {
    const usage = recordOf(recordOf(payload)?.usage);
    if (usage === null) {
      continue;
    }
    named = textOf(usage.contextModel) ?? named;
    if (!Array.isArray(usage.modelCosts)) {
      continue;
    }
    for (const entry of usage.modelCosts) {
      const split = recordOf(entry);
      const model = textOf(split?.model);
      const cost = split?.costUsd;
      if (model !== null && typeof cost === 'number') {
        spent.set(model, (spent.get(model) ?? 0) + cost);
      }
    }
  }
  let costliest: string | null = null;
  for (const [model, cost] of spent) {
    if (costliest === null || cost > (spent.get(costliest) ?? 0)) {
      costliest = model;
    }
  }
  return costliest ?? named;
}
