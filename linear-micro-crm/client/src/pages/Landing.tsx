// Owned by the Product Designer. The public first page: who Linear MCR is, how the company works, careers,
// and what Linear Hub gives the team. Shown at `/` when signed out and always at `/welcome` (so staff can
// review it). Outward-facing — for candidates, clients and staff — not a changelog (that is /about).
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowRight,
  Briefcase,
  CalendarDays,
  CreditCard,
  ExternalLink,
  Footprints,
  Gauge,
  GraduationCap,
  Handshake,
  HeartHandshake,
  Home,
  LogIn,
  MapPin,
  Menu as MenuIcon,
  PoundSterling,
  Presentation,
  ShieldCheck,
  Smartphone,
  Store,
  Table2,
  Target,
  Trophy,
  UserPlus,
  Users,
  Wallet,
} from 'lucide-react';
import clsx from 'clsx';
import {
  BENCHMARK_RATIOS,
  BRAND,
  GAUGE_KEYS,
  GAUGE_LABELS,
  POSITION_LABELS,
  RATIO_KEYS,
  ROLE_LABELS,
  type GaugeKey,
  type GaugeTotals,
  type Role,
} from '@lm/shared';
import { useAuth } from '@/auth/AuthProvider';
import { usePageTitle } from '@/lib/usePageTitle';
import { Logo, LogoMark } from '@/components/brand/Logo';
import { BrandBackdrop } from '@/components/brand/BrandBackdrop';
import { ThemeToggle } from '@/components/layout/theme';
import { Badge, Card, Dropdown, KpiTile } from '@/components/ui';
import { FunnelChart, Sparkline, TrendChart } from '@/components/charts';
import { GAUGE_HELP } from '@/content/copy';
import { ABOUT } from '@/content/about';
import { LANDING, type LandingFeature, type LandingIcon } from '@/content/landing';

/* ───────────────────────────── static maps ───────────────────────────── */

const ICONS: Record<LandingIcon, LucideIcon> = {
  Store, Briefcase, Home, HeartHandshake, Target, Wallet, Smartphone, Gauge, CalendarDays, Trophy, UserPlus, GraduationCap, Users, PoundSterling, ShieldCheck,
};

const GAUGE_ICONS: Record<GaugeKey, LucideIcon> = {
  stops: Footprints,
  table: Table2,
  presentations: Presentation,
  closes: Handshake,
  taps: CreditCard,
  sales: PoundSterling,
};

const ROLE_TONE: Record<Role, 'primary' | 'accent' | 'info' | 'success'> = { admin: 'accent', leader: 'primary', recruiter: 'info', rep: 'success' };

/** Stage-to-stage benchmarks in funnel order, paired with the gauges they connect. */
const BENCHMARKS = RATIO_KEYS.map((key, i) => ({ key, from: GAUGE_KEYS[i]!, to: GAUGE_KEYS[i + 1]!, value: BENCHMARK_RATIOS[key] }));
const OVERALL_BENCHMARK = BENCHMARKS.reduce((acc, b) => acc * b.value, 1);
const STOPS_PER_SALE = Math.round(1 / OVERALL_BENCHMARK);
const pct = (n: number, digits = 0) => `${(n * 100).toFixed(digits)}%`;

/** Illustrative figures for the product preview — a plausible week that sits on every benchmark. Not live data. */
const PREVIEW_TOTALS: GaugeTotals = { stops: 312, table: 118, presentations: 61, closes: 26, taps: 16, sales: 15 };
const PREVIEW_SALES_BY_WEEK = [9, 11, 10, 13, 12, 14, 13, 15];
const PREVIEW_TREND = PREVIEW_SALES_BY_WEEK.map((sales, i) => ({ week: `W${i + 1}`, sales }));

/* ───────────────────────────── page ───────────────────────────── */

export function LandingPage() {
  usePageTitle(BRAND.name); // "Linear MCR · Linear Hub"
  const { user } = useAuth();
  const signedIn = user != null;
  const appHref = signedIn ? '/' : '/login';
  const year = new Date().getFullYear();

  return (
    <div id="top" className="min-h-dvh bg-bg text-fg">
      <a
        href="#main"
        className="focus-ring sr-only z-[100] rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
      >
        Skip to content
      </a>

      <TopBar signedIn={signedIn} appHref={appHref} />

      <main id="main" tabIndex={-1} className="outline-none">
        <Hero signedIn={signedIn} appHref={appHref} />
        <WhatWeDo />
        <HowWeWork />
        <Careers />
        <Hub />
        <CtaBand signedIn={signedIn} appHref={appHref} />
      </main>

      <SiteFooter year={year} />
    </div>
  );
}

export default LandingPage;

/* ───────────────────────────── building blocks ───────────────────────────── */

function Container({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={clsx('mx-auto w-full max-w-[1200px] px-4 sm:px-6 lg:px-8', className)}>{children}</div>;
}

type CtaVariant = 'primary' | 'inverse' | 'outlineInverse' | 'outline';
type CtaSize = 'sm' | 'md' | 'lg';

const CTA_BASE = 'focus-ring inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium transition-colors duration-150 active:scale-[0.985] [&_svg]:h-4 [&_svg]:w-4';
const CTA_SIZE: Record<CtaSize, string> = {
  sm: 'h-9 rounded-lg px-3.5 text-sm',
  md: 'h-11 rounded-lg px-5 text-sm',
  lg: 'h-12 rounded-xl px-6 text-base [&_svg]:h-5 [&_svg]:w-5',
};
const CTA_VARIANT: Record<CtaVariant, string> = {
  primary: 'bg-primary text-primary-fg shadow-card hover:bg-primary-hover',
  inverse: 'bg-ink-fg text-ink shadow-card hover:bg-ink-fg/90',
  outlineInverse: 'border border-ink-fg/25 text-ink-fg hover:bg-ink-fg/10',
  outline: 'border border-border bg-surface text-fg shadow-card hover:bg-surface-2',
};
const ctaClass = (variant: CtaVariant, size: CtaSize, className?: string) => clsx(CTA_BASE, CTA_SIZE[size], CTA_VARIANT[variant], className);

interface CtaLinkProps { to: string; variant?: CtaVariant; size?: CtaSize; className?: string; icon?: ReactNode; children: ReactNode }

/** Navigation styled as a button (a real link, so it opens in new tabs and shows in the status bar). */
function CtaLink({ to, variant = 'primary', size = 'md', className, icon, children }: CtaLinkProps) {
  return (
    <Link to={to} className={ctaClass(variant, size, className)}>
      {children}
      {icon && <span className="inline-flex shrink-0 items-center" aria-hidden>{icon}</span>}
    </Link>
  );
}

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={clsx('text-[11px] font-semibold uppercase leading-tight tracking-[0.08em]', className ?? 'text-primary')}>{children}</p>;
}

interface SectionProps {
  id: string;
  eyebrow: string;
  title: ReactNode;
  afterTitle?: ReactNode;
  intro: string;
  /** `alt` sits on the surface colour so consecutive sections alternate. */
  tone?: 'default' | 'alt';
  children: ReactNode;
}

function Section({ id, eyebrow, title, afterTitle, intro, tone = 'default', children }: SectionProps) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={clsx('scroll-mt-20 py-16 sm:py-20', tone === 'alt' && 'border-y border-border bg-surface')}>
      <Container>
        <div className="max-w-2xl">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h2 id={`${id}-title`} className="mt-3 text-3xl font-bold tracking-tight sm:text-4xl">
            {title}
          </h2>
          {afterTitle}
          <p className="mt-4 text-base leading-relaxed text-muted sm:text-lg">{intro}</p>
        </div>
        <div className="mt-10 sm:mt-12">{children}</div>
      </Container>
    </section>
  );
}

interface FeatureCardProps extends LandingFeature {
  /** Heading level so the outline stays in order inside each section. */
  as?: 'h3' | 'h4';
  layout?: 'stacked' | 'row';
  /** Card background — `bg` on alt sections, `surface` elsewhere. */
  surface?: 'surface' | 'bg';
}

function FeatureCard({ icon, title, body, as: Heading = 'h3', layout = 'stacked', surface = 'surface' }: FeatureCardProps) {
  const Icon = ICONS[icon];
  return (
    <li className={clsx('flex min-w-0 rounded-xl border border-border p-5', surface === 'bg' ? 'bg-bg' : 'bg-surface shadow-card', layout === 'row' ? 'flex-row gap-4' : 'flex-col gap-4')}>
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary" aria-hidden>
        <Icon className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <Heading className="text-base font-semibold text-fg">{title}</Heading>
        <p className="mt-1.5 text-sm leading-relaxed text-muted">{body}</p>
      </div>
    </li>
  );
}

function ExternalSiteLink({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <a href={BRAND.website} target="_blank" rel="noreferrer noopener" className={className}>
      {children}
      <ExternalLink className="h-3.5 w-3.5" aria-hidden />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/* ───────────────────────────── top bar ───────────────────────────── */

function jumpTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ block: 'start' });
}

function TopBar({ signedIn, appHref }: { signedIn: boolean; appHref: string }) {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-topbar backdrop-blur-md">
      <Container className="flex h-16 items-center justify-between gap-3">
        <a href="#top" className="focus-ring rounded-lg">
          <Logo size={28} text={BRAND.name} title={`${BRAND.name} — back to top`} />
        </a>

        <nav aria-label="Sections" className="hidden items-center gap-1 md:flex">
          {LANDING.nav.map((n) => (
            <a key={n.id} href={`#${n.id}`} className="focus-ring rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg">
              {n.label}
            </a>
          ))}
        </nav>

        <div className="flex items-center gap-1.5">
          <ThemeToggle />
          <div className="md:hidden">
            <Dropdown
              align="end"
              width={200}
              items={LANDING.nav.map((n) => ({ label: n.label, onSelect: () => jumpTo(n.id) }))}
              trigger={
                <button type="button" aria-label="Page sections" className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg">
                  <MenuIcon className="h-[18px] w-[18px]" aria-hidden />
                </button>
              }
            />
          </div>
          <CtaLink to={appHref} size="sm" className="ml-1">
            {signedIn ? 'Open dashboard' : LANDING.hero.primaryCta}
          </CtaLink>
        </div>
      </Container>
    </header>
  );
}

/* ───────────────────────────── hero + preview ───────────────────────────── */

function Hero({ signedIn, appHref }: { signedIn: boolean; appHref: string }) {
  const h = LANDING.hero;
  return (
    <section className="relative overflow-hidden bg-ink text-ink-fg" aria-labelledby="hero-title">
      <BrandBackdrop intensity="soft" />
      <Container className="relative grid gap-12 py-14 sm:py-20 lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:items-center lg:gap-16 lg:py-28">
        <div className="max-w-xl animate-slide-up">
          <Eyebrow className="text-ink-muted">
            {BRAND.name} · {h.eyebrow}
          </Eyebrow>
          <h1 id="hero-title" className="mt-4 font-display text-[38px] font-bold leading-[1.05] tracking-tight text-ink-fg sm:text-5xl lg:text-[56px]">
            {h.headline}
          </h1>
          <p className="mt-5 max-w-lg text-base leading-relaxed text-ink-muted sm:text-lg">{h.subheadline}</p>

          <div className="mt-8 flex flex-wrap gap-3">
            <CtaLink to={appHref} variant="inverse" size="lg" icon={<ArrowRight />}>
              {signedIn ? 'Open dashboard' : h.primaryCta}
            </CtaLink>
            <a href="#what-we-do" className={ctaClass('outlineInverse', 'lg')}>
              {h.secondaryCta}
            </a>
          </div>

          <dl className="mt-10 grid grid-cols-2 gap-x-6 gap-y-5 sm:grid-cols-4">
            {h.facts.map((f) => (
              <div key={f.label} className="min-w-0">
                <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-muted">{f.label}</dt>
                <dd className="mt-1 text-sm font-semibold text-ink-fg">{f.value}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="relative min-w-0 animate-slide-up [animation-delay:120ms]">
          <DashboardPreview />
          <p className="mt-3 text-xs text-ink-muted">{h.previewCaption}</p>
        </div>
      </Container>
    </section>
  );
}

/** A stylised mock of the rep dashboard, built from the real UI kit and charts with illustrative figures. */
function DashboardPreview() {
  const conversion = PREVIEW_TOTALS.sales / PREVIEW_TOTALS.stops;
  return (
    <Card padded={false} className="overflow-hidden text-fg shadow-modal" role="group" aria-label="Illustrative preview of the Linear Hub dashboard">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-2/60 px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <LogoMark size={20} title="" />
          <span className="truncate text-sm font-semibold text-fg">Dashboard</span>
          <span className="hidden text-xs text-muted sm:inline">· This week</span>
        </div>
        <Badge tone="accent" size="sm">{LANDING.hero.previewLabel}</Badge>
      </div>

      <div className="grid gap-3 p-4 sm:grid-cols-3">
        <KpiTile
          size="sm"
          className="shadow-none"
          label={GAUGE_LABELS.sales}
          value={PREVIEW_TOTALS.sales}
          delta={0.07}
          deltaLabel="vs last week"
          tone="primary"
          sparkline={<Sparkline data={PREVIEW_SALES_BY_WEEK} width={72} height={28} ariaLabel="Sales trend, eight weeks, rising" />}
        />
        <KpiTile size="sm" className="shadow-none" label="Conversion" value={pct(conversion, 1)} tone="success" hint="sales ÷ stops" />
        <KpiTile size="sm" className="shadow-none" label="Next payday" value="Friday" hint="£675.00 · gross, this week" />
      </div>

      <div className="grid gap-3 px-4 pb-4 lg:grid-cols-[1.15fr_1fr]">
        <div className="min-w-0 rounded-xl border border-border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-fg">Funnel</span>
            <span className="text-[11px] text-muted">vs benchmark</span>
          </div>
          <FunnelChart totals={PREVIEW_TOTALS} showBenchmarks compact barHeight={64} />
        </div>
        <div className="min-w-0 rounded-xl border border-border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-fg">Sales by week</span>
            <span className="text-[11px] text-muted">8 weeks</span>
          </div>
          <TrendChart data={PREVIEW_TREND} xKey="week" series={[{ key: 'sales', label: 'Sales' }]} kind="area" height={128} />
        </div>
      </div>
    </Card>
  );
}

/* ───────────────────────────── sections ───────────────────────────── */

function WhatWeDo() {
  const s = LANDING.whatWeDo;
  return (
    <Section id="what-we-do" eyebrow={s.eyebrow} title={s.title} intro={s.intro}>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {s.items.map((item) => (
          <FeatureCard key={item.title} {...item} />
        ))}
      </ul>
    </Section>
  );
}

function HowWeWork() {
  const s = LANDING.howWeWork;
  const law = s.lawOfAverages.body.replace('{stopsPerSale}', String(STOPS_PER_SALE)).replace('{overall}', pct(OVERALL_BENCHMARK, 1));
  return (
    <Section id="how-we-work" tone="alt" eyebrow={s.eyebrow} title={s.title} intro={s.intro}>
      <h3 className="sr-only">{s.gaugesHeading}</h3>
      <ol className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {GAUGE_KEYS.map((key, i) => {
          const Icon = GAUGE_ICONS[key];
          return (
            <li key={key} className="flex min-w-0 gap-4 rounded-xl border border-border bg-bg p-5">
              <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary" aria-hidden>
                <Icon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="kpi-number text-xs text-primary" aria-hidden>
                    {String(i + 1).padStart(2, '0')}
                  </span>
                  <h4 className="text-base font-semibold text-fg">{GAUGE_LABELS[key]}</h4>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-muted">{GAUGE_HELP[key]}</p>
              </div>
            </li>
          );
        })}
      </ol>

      <Card tone="primary" className="mt-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-center">
          <div>
            <h3 className="text-xl font-semibold text-fg">{s.lawOfAverages.title}</h3>
            <p className="mt-2 text-sm leading-relaxed text-fg/85 sm:text-base">{law}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{s.lawOfAverages.chipsLabel}</p>
            <ul className="mt-2 flex flex-wrap gap-2">
              {BENCHMARKS.map((b) => (
                <li key={b.key} className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-fg">
                  <span className="truncate text-muted">{GAUGE_LABELS[b.from]}</span>
                  <ArrowRight className="h-3 w-3 shrink-0 text-muted" aria-hidden />
                  <span className="truncate text-muted">{GAUGE_LABELS[b.to]}</span>
                  <span className="font-semibold tabular text-success">{pct(b.value)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>

      <ul className="mt-6 grid gap-4 sm:grid-cols-3">
        {s.pillars.map((p) => (
          <FeatureCard key={p.title} {...p} surface="bg" />
        ))}
      </ul>
    </Section>
  );
}

function Careers() {
  const s = LANDING.careers;
  return (
    <Section
      id="careers"
      eyebrow={s.eyebrow}
      title={<>“{s.quote}”</>}
      afterTitle={<p className="mt-3 text-sm font-medium text-muted">— {s.quoteAttribution}</p>}
      intro={s.intro}
    >
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{s.ladderHeading}</h3>
      <ol className="relative mt-5 grid gap-7 sm:grid-cols-3 lg:grid-cols-6 lg:gap-5">
        {/* connecting line: vertical on phones, horizontal from lg */}
        <div className="absolute bottom-3 left-4 top-3 w-px bg-border-strong sm:hidden" aria-hidden />
        <div className="absolute left-0 right-0 top-4 hidden h-px bg-border-strong lg:block" aria-hidden />
        {s.ladder.map((pos, i) => (
          <li key={pos} className="relative flex min-w-0 gap-4 sm:block">
            <span className="kpi-number relative z-10 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm text-primary-fg ring-4 ring-bg" aria-hidden>
              {i + 1}
            </span>
            <div className="min-w-0 sm:mt-4">
              <h4 className="text-sm font-semibold text-fg">
                <span className="sr-only">Step {i + 1}: </span>
                {POSITION_LABELS[pos]}
              </h4>
              <p className="mt-1 text-xs leading-relaxed text-muted">{s.ladderNotes[pos]}</p>
            </div>
          </li>
        ))}
      </ol>

      <h3 className="mt-14 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{s.offersHeading}</h3>
      <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {s.offers.map((o) => (
          <FeatureCard key={o.title} {...o} as="h4" />
        ))}
      </ul>

      <ExternalSiteLink className="focus-ring mt-8 inline-flex items-center gap-1.5 rounded-md text-sm font-medium text-primary underline-offset-4 hover:underline">
        {s.cta}
      </ExternalSiteLink>
    </Section>
  );
}

function Hub() {
  const s = LANDING.hub;
  return (
    <Section id="linear-hub" tone="alt" eyebrow={s.eyebrow} title={s.title} intro={s.intro}>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {s.features.map((f) => (
          <FeatureCard key={f.title} {...f} layout="row" surface="bg" />
        ))}
      </ul>

      <div className="mt-14">
        <h3 className="text-xl font-semibold text-fg">{s.rolesHeading}</h3>
        <p className="mt-1 text-sm text-muted">{s.rolesIntro}</p>
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {ABOUT.whoItsFor.map((r) => (
            <li key={r.role} className="min-w-0 rounded-xl border border-border bg-bg p-5">
              <div className="flex items-start justify-between gap-2">
                <h4 className="text-sm font-semibold text-fg">{r.title}</h4>
                <Badge tone={ROLE_TONE[r.role]} size="sm">{ROLE_LABELS[r.role]}</Badge>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-muted">{r.description}</p>
            </li>
          ))}
        </ul>
        <p className="mt-6 inline-flex items-start gap-2 text-sm text-muted">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden />
          {s.signInNote}
        </p>
      </div>
    </Section>
  );
}

function CtaBand({ signedIn, appHref }: { signedIn: boolean; appHref: string }) {
  const c = signedIn ? LANDING.cta.signedIn : LANDING.cta.signedOut;
  return (
    <section aria-labelledby="cta-title" className="relative overflow-hidden bg-ink text-ink-fg">
      <div className="brand-lines absolute inset-0 opacity-70 [mask-image:linear-gradient(to_right,transparent,black)]" aria-hidden />
      <Container className="relative flex flex-col items-start gap-6 py-14 sm:flex-row sm:items-center sm:justify-between sm:py-16">
        <div className="max-w-xl">
          <h2 id="cta-title" className="text-3xl font-bold tracking-tight text-ink-fg">{c.title}</h2>
          <p className="mt-2 text-base leading-relaxed text-ink-muted">{c.body}</p>
        </div>
        <CtaLink to={appHref} variant="inverse" size="lg" icon={<LogIn />}>
          {c.button}
        </CtaLink>
      </Container>
    </section>
  );
}

function SiteFooter({ year }: { year: number }) {
  const f = LANDING.footer;
  const link = 'focus-ring rounded-md text-sm text-muted transition-colors hover:text-fg';
  return (
    <footer className="border-t border-border bg-surface">
      <Container className="grid gap-10 py-12 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)]">
        <div className="min-w-0">
          <Logo size={28} text={BRAND.name} title={BRAND.name} />
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted">{BRAND.tagline} Face-to-face sales for brands and charities across Greater Manchester and the North West.</p>
          <p className="mt-4 inline-flex items-center gap-1.5 text-sm text-fg">
            <MapPin className="h-4 w-4 text-primary" aria-hidden />
            <span className="font-medium">{f.madeIn}</span>
          </p>
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">{f.contactHeading}</h2>
          <address className="mt-3 space-y-1 text-sm not-italic text-muted">
            <div>{BRAND.legalName}</div>
            <div>{f.address}</div>
            <div>
              <ExternalSiteLink className="focus-ring inline-flex items-center gap-1 rounded-md text-primary underline-offset-4 hover:underline">{f.websiteLabel}</ExternalSiteLink>
            </div>
          </address>
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fg">{f.exploreHeading}</h2>
          <ul className="mt-3 space-y-2">
            {LANDING.nav.map((n) => (
              <li key={n.id}>
                <a href={`#${n.id}`} className={link}>{n.label}</a>
              </li>
            ))}
            <li>
              <Link to="/login" className={clsx(link, 'font-medium text-primary hover:text-primary-hover')}>{f.signIn}</Link>
            </li>
          </ul>
        </div>
      </Container>
      <div className="border-t border-border">
        <Container className="flex flex-col gap-2 py-5 text-xs text-muted sm:flex-row sm:items-center sm:justify-between">
          <span>© {year} {BRAND.legalName}. {f.rights}</span>
          <span className="inline-flex items-center gap-1.5">
            <LogoMark size={14} title="" /> {BRAND.product} · {BRAND.city}
          </span>
        </Container>
      </div>
    </footer>
  );
}
