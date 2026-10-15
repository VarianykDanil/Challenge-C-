// Owned by Marketing & Content. Product story, what Linear Hub tracks, and the squad who built it.
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  CreditCard,
  Footprints,
  Gauge,
  Handshake,
  MapPin,
  PoundSterling,
  Presentation,
  ShieldCheck,
  Smartphone,
  Table2,
  Wallet,
} from 'lucide-react';
import { BENCHMARK_RATIOS, BRAND, GAUGE_KEYS, GAUGE_LABELS, ROLE_LABELS, type GaugeKey } from '@lm/shared';
import { Avatar, Badge, Card, CardHeader, PageHeader } from '@/components/ui';
import { Logo } from '@/components/brand/Logo';
import { COPY, GAUGE_HELP } from '@/content/copy';
import { TEAM_MEMBERS } from '@/content/team';
import { ABOUT } from '@/content/about';

const GAUGE_ICONS: Record<GaugeKey, LucideIcon> = {
  stops: Footprints,
  table: Table2,
  presentations: Presentation,
  closes: Handshake,
  taps: CreditCard,
  sales: PoundSterling,
};

const PRINCIPLE_ICONS: LucideIcon[] = [Gauge, ShieldCheck, Wallet, Smartphone];

/** Stage-to-stage benchmarks in funnel order, paired with the gauges they connect. */
const BENCHMARKS: { from: GaugeKey; to: GaugeKey; value: number }[] = [
  { from: 'stops', to: 'table', value: BENCHMARK_RATIOS.stopToTable },
  { from: 'table', to: 'presentations', value: BENCHMARK_RATIOS.tableToPresentation },
  { from: 'presentations', to: 'closes', value: BENCHMARK_RATIOS.presentationToClose },
  { from: 'closes', to: 'taps', value: BENCHMARK_RATIOS.closeToTap },
  { from: 'taps', to: 'sales', value: BENCHMARK_RATIOS.tapToSale },
];

const OVERALL_BENCHMARK = BENCHMARKS.reduce((acc, b) => acc * b.value, 1);
const STOPS_PER_SALE = Math.round(1 / OVERALL_BENCHMARK);

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function AboutPage() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title={COPY.nav.about.title}
        description={COPY.nav.about.description}
        actions={<Badge tone="primary">Version {ABOUT.version}</Badge>}
      />

      {/* Hero */}
      <Card className="mb-6" padded={false}>
        <div className="flex flex-col gap-6 p-6 sm:flex-row sm:items-center sm:p-8">
          <Logo variant="mark" size={64} title="" className="shadow-sm" />
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted">Built for {BRAND.legalName}</p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-fg">
              {COPY.product} <span className="font-normal text-muted">— {COPY.tagline}</span>
            </h2>
            <p className="mt-2 max-w-2xl text-base text-muted">{ABOUT.mission}</p>
          </div>
        </div>
      </Card>

      {/* Story */}
      <Card className="mb-6">
        <CardHeader title="The story" description="Why a face-to-face sales company needed its own platform." />
        <div className="space-y-4 text-sm leading-relaxed text-fg">
          {ABOUT.story.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </div>
      </Card>

      {/* What it tracks */}
      <Card className="mb-6">
        <CardHeader
          title="What it tracks"
          description="The six gauges, in funnel order. Each stage can never be larger than the one before it."
        />
        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {GAUGE_KEYS.map((key, i) => {
            const Icon = GAUGE_ICONS[key];
            return (
              <li key={key} className="flex gap-3 rounded-lg border border-border bg-surface-2 p-4">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="h-5 w-5" aria-hidden />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold tabular-nums text-muted">{i + 1}</span>
                    <h4 className="text-sm font-semibold text-fg">{GAUGE_LABELS[key]}</h4>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{GAUGE_HELP[key]}</p>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-5 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 className="text-sm font-semibold text-fg">The law of averages</h4>
            <p className="text-xs text-muted">
              Hit every benchmark and roughly 1 in {STOPS_PER_SALE} stops becomes a sale ({pct(OVERALL_BENCHMARK)} overall).
            </p>
          </div>
          <ul className="mt-3 flex flex-wrap gap-2">
            {BENCHMARKS.map((b) => (
              <li
                key={`${b.from}-${b.to}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1 text-xs text-fg"
              >
                <span className="text-muted">{GAUGE_LABELS[b.from]}</span>
                <ArrowRight className="h-3 w-3 text-muted" aria-hidden />
                <span className="text-muted">{GAUGE_LABELS[b.to]}</span>
                <span className="font-semibold tabular-nums text-success">{pct(b.value)}</span>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      {/* Who it is for */}
      <Card className="mb-6">
        <CardHeader title="Who it is for" description="One sign-in per person. What you see depends on your role." />
        <div className="grid gap-3 sm:grid-cols-2">
          {ABOUT.whoItsFor.map((item) => (
            <div key={item.role} className="rounded-lg border border-border p-4">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-sm font-semibold text-fg">{item.title}</h4>
                <Badge tone={item.role === 'admin' ? 'accent' : item.role === 'leader' ? 'primary' : item.role === 'recruiter' ? 'info' : 'neutral'}>
                  {ROLE_LABELS[item.role]}
                </Badge>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">{item.description}</p>
            </div>
          ))}
        </div>
      </Card>

      {/* Principles */}
      <Card className="mb-6">
        <CardHeader title="How we built it" description="Four principles we held to." />
        <ul className="grid gap-4 sm:grid-cols-2">
          {ABOUT.principles.map((p, i) => {
            const Icon = PRINCIPLE_ICONS[i % PRINCIPLE_ICONS.length]!;
            return (
              <li key={p.title} className="flex gap-3">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-2 text-primary">
                  <Icon className="h-4.5 w-4.5" aria-hidden />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-fg">{p.title}</h4>
                  <p className="mt-1 text-xs leading-relaxed text-muted">{p.body}</p>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      {/* Squad */}
      <Card className="mb-6">
        <CardHeader title="The squad" description="Five people, five slices of the codebase, one integrator merge." />
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TEAM_MEMBERS.map((m) => (
            <li key={m.name} className="flex gap-3 rounded-lg border border-border bg-surface-2 p-4">
              <Avatar name={m.name} color={m.color} size="lg" />
              <div className="min-w-0">
                <h4 className="text-sm font-semibold text-fg">{m.name}</h4>
                <Badge tone="neutral" className="mt-1">{m.role}</Badge>
                <p className="mt-2 text-xs leading-relaxed text-muted">{m.focus}</p>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      {/* Stack */}
      <Card className="mb-6">
        <CardHeader title="Under the bonnet" description="A small, modern stack with no external services to pay for or keep online." />
        <ul className="flex flex-wrap gap-2">
          {ABOUT.stack.map((s) => (
            <li key={s.name}>
              <Badge tone="neutral" title={s.detail} className="px-3 py-1">
                <span className="font-semibold text-fg">{s.name}</span>
                <span aria-hidden>·</span>
                <span>{s.detail}</span>
              </Badge>
            </li>
          ))}
        </ul>
      </Card>

      {/* Footer */}
      <footer className="flex flex-col items-center gap-2 border-t border-border py-6 text-center text-xs text-muted sm:flex-row sm:justify-between sm:text-left">
        <p className="inline-flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5 text-primary" aria-hidden />
          <span className="font-medium text-fg">{ABOUT.madeIn}</span>
          <span aria-hidden>·</span>
          <span>{BRAND.address}</span>
        </p>
        <p>
          {COPY.product} v{ABOUT.version} · © {BRAND.legalName} — internal use
        </p>
      </footer>
    </div>
  );
}

export default AboutPage;
