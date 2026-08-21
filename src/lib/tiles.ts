export type TileAccent = "coral" | "lavender" | "sage" | "gold";

export type Tile = {
  title: string;
  accent: TileAccent;
  phase: string;
  body: string;
};

export const ACCENT: Record<
  TileAccent,
  { border: string; dot: string; pill: string }
> = {
  coral: { border: "border-coral", dot: "bg-coral", pill: "text-coral" },
  lavender: {
    border: "border-lavender",
    dot: "bg-lavender",
    pill: "text-lavender",
  },
  sage: { border: "border-sage", dot: "bg-sage", pill: "text-sage" },
  gold: { border: "border-gold", dot: "bg-gold", pill: "text-gold" },
};

export const TILES: Tile[] = [
  {
    title: "Check-ins",
    accent: "lavender",
    phase: "Phase 3",
    body: "Daily mood check-ins with private notes and parent responses — sensitive by design.",
  },
  {
    title: "The Couch",
    accent: "coral",
    phase: "Phase 4",
    body: "A shared family agreement. Parents set sections; children can suggest additions for approval.",
  },
  {
    title: "Goals",
    accent: "sage",
    phase: "Phase 5",
    body: "School goals with progress children track themselves and teacher notes parents record.",
  },
  {
    title: "Points & Rewards",
    accent: "gold",
    phase: "Phase 6",
    body: "An honest points ledger that powers a family reward catalogue and redemption requests.",
  },
  {
    title: "Responsibilities",
    accent: "coral",
    phase: "Phase 6.5",
    body: "Parents assign chores; children mark them done for approval, earning points on the same ledger.",
  },
];
