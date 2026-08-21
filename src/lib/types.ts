export type FamilyRole = "parent" | "child";

export type Profile = {
  id: string;
  family_id: string;
  display_name: string;
  role: FamilyRole;
  avatar_emoji: string | null;
  date_of_birth: string | null;
  points_balance: number;
  support_mode: boolean;
  created_at: string;
};

export type Family = {
  id: string;
  name: string;
  created_at: string;
};

export type Invite = {
  id: string;
  family_id: string;
  code: string;
  role: FamilyRole;
  expires_at: string;
  claimed_by: string | null;
  claimed_at: string | null;
  created_by: string;
  created_at: string;
};
