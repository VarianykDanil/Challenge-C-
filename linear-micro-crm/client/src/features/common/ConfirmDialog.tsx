import type { ReactNode } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { Button, Modal } from '@/components/ui';

export function ConfirmDialog({ open, onClose, onConfirm, title, description, confirmLabel = 'Confirm', tone = 'primary', loading, children }: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel?: string;
  tone?: 'primary' | 'danger';
  loading?: boolean;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      tone={tone === 'danger' ? 'danger' : 'default'}
      icon={tone === 'danger' ? <AlertTriangle aria-hidden /> : <HelpCircle aria-hidden />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant={tone} onClick={onConfirm} loading={loading}>{confirmLabel}</Button>
        </>
      }
    >
      {children ?? null}
    </Modal>
  );
}
