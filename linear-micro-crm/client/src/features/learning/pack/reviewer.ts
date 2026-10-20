// Release 1.2 — L1: who signs a teach-back off, in words. A team member's leader does; people with no team leader
// (recruiters, admins, anyone not on a team) are signed off by the office.
import type { Role } from '@lm/shared';

export function reviewerWord(me: { role: Role; teamId: number | null }): 'your leader' | 'the office' {
  return me.role === 'recruiter' || me.role === 'admin' || me.teamId === null ? 'the office' : 'your leader';
}
