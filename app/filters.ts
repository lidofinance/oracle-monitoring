// Multi-select filters of the console. A selection is a list of option
// values; an empty list means that the filter is off and everything passes.

// Read a selection from a comma-separated URL parameter. Unknown values are
// dropped and the result follows the order of `options`.
export function parseSelection<T extends string>(
  value: string | null,
  options: readonly T[],
): T[] {
  const values = new Set((value ?? "").toLowerCase().split(","));
  return options.filter((option) => values.has(option.toLowerCase()));
}

// Add the value to the selection or remove it when it is already selected.
// The result follows the order of `options`.
export function toggleSelection<T extends string>(
  selected: readonly T[],
  value: T,
  options: readonly T[],
): T[] {
  const next = new Set(selected);
  if (!next.delete(value)) next.add(value);
  return options.filter((option) => next.has(option));
}

export type FilterGroup<Item> = {
  selected: readonly string[];
  // Option the item belongs to; undefined when it matches no option.
  valueOf: (item: Item) => string | undefined;
};

// Apply several filter groups at once: an item passes when every group with
// a selection includes its value. Also count the items per option of every
// group. A count ignores the selection of its own group, so it shows how many
// items the option would give together with the other filters.
export function filterWithCounts<Item, Key extends string>(
  items: readonly Item[],
  groups: Record<Key, FilterGroup<Item>>,
): { items: Item[]; counts: Record<Key, Map<string, number>> } {
  const keys = Object.keys(groups) as Key[];
  const counts = Object.fromEntries(
    keys.map((key) => [key, new Map<string, number>()]),
  ) as Record<Key, Map<string, number>>;
  const passed: Item[] = [];

  for (const item of items) {
    const values = keys.map((key) => groups[key].valueOf(item));
    const failed = keys.filter((key, index) => {
      const { selected } = groups[key];
      const value = values[index];
      return (
        selected.length > 0 && (value === undefined || !selected.includes(value))
      );
    });
    if (failed.length > 1) continue;
    if (!failed.length) passed.push(item);
    // An item that fails only one group still counts for that group.
    keys.forEach((key, index) => {
      const value = values[index];
      if (value === undefined || (failed.length && failed[0] !== key)) return;
      counts[key].set(value, (counts[key].get(value) ?? 0) + 1);
    });
  }
  return { items: passed, counts };
}
