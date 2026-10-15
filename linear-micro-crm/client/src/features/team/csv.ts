// CSV columns for the Team directory.
import type { UserWithTeam } from '@lm/shared';
import { POSITION_LABELS } from '@lm/shared';
import { csvDate, csvLabel, type CsvColumn } from '@/lib/csv';
import { fullName } from '@/lib/format';
import { USER_STATUS_LABELS } from '@/lib/labels';

/** Employee IDs double as sign-in codes, so the API only returns them to admins — include the column only when present. */
export function userCsvColumns(includeEmployeeId: boolean): CsvColumn<UserWithTeam>[] {
  return [
    { key: 'name', header: 'Name', format: (_, u) => fullName(u) },
    { key: 'email', header: 'Email' },
    { key: 'position', header: 'Position', format: csvLabel(POSITION_LABELS) },
    { key: 'teamName', header: 'Team' },
    { key: 'status', header: 'Status', format: csvLabel(USER_STATUS_LABELS) },
    { key: 'startDate', header: 'Start date', format: csvDate },
    ...(includeEmployeeId ? [{ key: 'employeeId', header: 'Employee ID' } satisfies CsvColumn<UserWithTeam>] : []),
  ];
}
