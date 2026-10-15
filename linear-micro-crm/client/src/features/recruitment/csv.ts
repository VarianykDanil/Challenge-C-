// CSV columns for candidate rows (Recruitment list view and the board's Hired column).
import type { CandidateWithMeta } from '@lm/shared';
import { POSITION_LABELS, SOURCE_LABELS, STAGE_LABELS } from '@lm/shared';
import { csvDate, csvLabel, type CsvColumn } from '@/lib/csv';
import { fullName } from '@/lib/format';

export const candidateCsvColumns: CsvColumn<CandidateWithMeta>[] = [
  { key: 'name', header: 'Name', format: (_, c) => fullName(c) },
  { key: 'email', header: 'Email' },
  { key: 'phone', header: 'Phone' },
  { key: 'city', header: 'City' },
  { key: 'source', header: 'Source', format: csvLabel(SOURCE_LABELS) },
  { key: 'stage', header: 'Stage', format: csvLabel(STAGE_LABELS) },
  { key: 'positionApplied', header: 'Position applied', format: csvLabel(POSITION_LABELS) },
  { key: 'appliedAt', header: 'Applied', format: csvDate },
  { key: 'stageUpdatedAt', header: 'Stage updated', format: csvDate },
  { key: 'ownerName', header: 'Owner' },
  { key: 'rating', header: 'Rating' },
  { key: 'nextAction', header: 'Next action' },
  { key: 'nextActionAt', header: 'Next action date', format: csvDate },
  { key: 'daysInPipeline', header: 'Days in pipeline' },
];
