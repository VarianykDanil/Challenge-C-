// Release 1.3 slot — OWNED BY P6 client-portal. The badge "From Breast Cancer Now" on an announcement a campaign's
// client posted (announcement.fromClient), a link to that campaign's page, and, for administrators, "Unpublish" (it removes the announcement; the
// client sees "Unpublished"). Mounted in features/dashboard/Announcements.tsx in each item's title row, after the title,
// in an ErrorBoundary with fallback={null}. Nothing for the office's own announcements. The client post behind the
// announcement is looked up only when Unpublish is pressed.
import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { EyeOff } from 'lucide-react';
import type { Announcement } from '@lm/shared';
import { useAuth } from '@/auth/AuthProvider';
import { useClientPosts, useDecideClientPost } from '@/api/clientPortal';
import { Badge, Button, Field, Textarea, useToast } from '@/components/ui';
import { ConfirmDialog } from '@/features/common/ConfirmDialog';
import { errorMessage } from '@/features/common/QueryStates';

export interface AnnouncementSourceBadgeProps {
  announcement: Announcement;
}

export function AnnouncementSourceBadge({ announcement }: AnnouncementSourceBadgeProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const source = announcement.fromClient;
  if (!source) return null;
  return (
    <span className="flex min-w-0 shrink-0 items-center gap-1" data-testid="announcement-source">
      {/* "From BCN" in a narrow card (the dashboard's third column, a phone), "From Breast Cancer Now" where there is
          room (the card is a size container); screen readers always hear the full name. It opens the campaign's page
          (every staff role); the padding gives it a 40 px tap target without making the row taller. */}
      <Link
        to={`/campaigns/${source.campaignId}`}
        className="focus-ring -my-2.5 inline-flex min-w-0 items-center rounded-full py-2.5"
        title={`Posted by ${source.campaignName} from the client portal. Open the campaign page.`}
      >
        <Badge size="sm" tone="neutral" dot color={source.campaignColor} className="max-w-[16rem]">
          <span aria-hidden className="@sm:hidden">From {source.campaignCode}</span>
          <span aria-hidden className="hidden truncate @sm:inline">From {source.campaignName}</span>
          <span className="sr-only">From {source.campaignName}, open the campaign page</span>
        </Badge>
      </Link>
      {user?.role === 'admin' && (
        <>
          <Button variant="ghost" size="icon" label="Unpublish this client post" onClick={() => setOpen(true)} className="-my-2">
            <EyeOff aria-hidden />
          </Button>
          {open && <UnpublishDialog announcement={announcement} onClose={() => setOpen(false)} />}
        </>
      )}
    </span>
  );
}

function UnpublishDialog({ announcement, onClose }: { announcement: Announcement; onClose: () => void }) {
  const toast = useToast();
  const uid = useId();
  const [note, setNote] = useState('');
  const posts = useClientPosts({ status: 'published', campaignId: announcement.fromClient?.campaignId ?? null });
  const decide = useDecideClientPost();
  const post = posts.data?.find((p) => p.announcementId === announcement.id);
  const name = announcement.fromClient?.campaignName ?? 'the client';
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      tone="danger"
      title="Unpublish this post?"
      description={`“${announcement.title}” comes off Announcements for everyone. ${name} sees it as Unpublished in their portal.`}
      confirmLabel="Unpublish"
      loading={decide.isPending || posts.isLoading}
      onConfirm={() => {
        if (!post) {
          toast.error('Could not find the client post', posts.isError ? errorMessage(posts.error) : 'It may have been unpublished already.');
          return;
        }
        decide.mutate(
          { id: post.id, action: 'unpublish', note: note.trim() || undefined },
          {
            onSuccess: () => {
              toast.success('Unpublished', `${name} sees it as Unpublished.`);
              onClose();
            },
            onError: (e) => toast.error('Could not unpublish it', errorMessage(e)),
          },
        );
      }}
    >
      <Field label="Note for the office" optional htmlFor={`${uid}-note`} hint="Only the office sees it, in the audit trail and on the campaign page, e.g. “Posted twice by mistake”. The client does not.">
        <Textarea id={`${uid}-note`} rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </ConfirmDialog>
  );
}
