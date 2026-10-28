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
  CheckCircle2,
  ExternalLink,
  GraduationCap,
  HeartHandshake,
  Home,
  LogIn,
  MapPin,
  Menu as MenuIcon,
  ShieldCheck,
  Smartphone,
  Store,
  Target,
  Trophy,
  UserPlus,
  Users,
} from 'lucide-react';
import clsx from 'clsx';
import { BRAND } from '@lm/shared';
import { useAuth } from '@/auth/AuthProvider';
import { usePageTitle } from '@/lib/usePageTitle';
import { Logo, LogoMark } from '@/components/brand/Logo';
import { BrandBackdrop } from '@/components/brand/BrandBackdrop';
import { ThemeToggle } from '@/components/layout/theme';
import { Badge, Card, Dropdown, KpiTile } from '@/components/ui';
import { Sparkline, TrendChart } from '@/components/charts';
import { LANDING, type LandingFeature, type LandingIcon, type LandingLadderLevel } from '@/content/landing';

/* ───────────────────────────── static maps ───────────────────────────── */

const ICONS: Record<LandingIcon, LucideIcon> = {
  Store, Briefcase, Home, HeartHandshake, Target, Smartphone, CalendarDays, Trophy, UserPlus, GraduationCap, Users, ShieldCheck,
};

/** Illustrative figures for the product preview. Not live data. */
const PREVIEW_SALES_BY_WEEK = [9, 11, 10, 13, 12, 14, 13, 15];
const PREVIEW_TREND = PREVIEW_SALES_BY_WEEK.map((sales, i) => ({ week: `W${i + 1}`, sales }));
const PREVIEW_EVENTS = [
  { day: 'Mon', place: 'Shopping centre stand', kind: 'Charity', done: true },
  { day: 'Wed', place: 'Business visits', kind: 'B2B', done: false },
  { day: 'Sat', place: 'Retail park event', kind: 'B2C', done: false },
];

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
        <Link
          to="/welcome"
          onClick={() => window.scrollTo({ top: 0 })}
          aria-label={`${BRAND.name} — top of the public page`}
          className="focus-ring -m-1 inline-flex rounded-lg p-1 transition-colors hover:bg-surface-2 focus-visible:bg-surface-2"
        >
          <Logo size={28} text={BRAND.name} />
        </Link>

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
      <BrandBackdrop intensity="strong" variant="ink" vignette="left" />
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
          label="Sales"
          value={PREVIEW_SALES_BY_WEEK[PREVIEW_SALES_BY_WEEK.length - 1]!}
          delta={0.07}
          deltaLabel="vs last week"
          tone="primary"
          sparkline={<Sparkline data={PREVIEW_SALES_BY_WEEK} width={72} height={28} ariaLabel="Sales trend, eight weeks, rising" />}
        />
        <KpiTile size="sm" className="shadow-none" label="Events" value={PREVIEW_EVENTS.length} tone="success" hint="this week" />
        <KpiTile size="sm" className="shadow-none" label="Training" value="14 / 21" hint="lessons done" />
      </div>

      <div className="grid gap-3 px-4 pb-4 lg:grid-cols-[1fr_1.15fr]">
        <div className="min-w-0 rounded-xl border border-border p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-xs font-semibold text-fg">This week</span>
            <span className="text-[11px] text-muted">Events</span>
          </div>
          <ul className="divide-y divide-border">
            {PREVIEW_EVENTS.map((e) => (
              <li key={e.day} className="flex items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium text-fg">
                    {e.day} · {e.place}
                  </span>
                  <span className="text-[11px] text-muted">{e.kind}</span>
                </span>
                {e.done ? (
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> Checked in
                  </span>
                ) : (
                  <span className="shrink-0 text-[11px] text-muted">Booked</span>
                )}
              </li>
            ))}
          </ul>
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
  return (
    <Section id="how-we-work" tone="alt" eyebrow={s.eyebrow} title={s.title} intro={s.intro}>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
      <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{s.principlesHeading}</h3>
      <ul className="mt-5 grid gap-4 sm:grid-cols-3">
        {s.principles.map((p) => (
          <FeatureCard key={p.title} {...p} as="h4" />
        ))}
      </ul>

      <h3 className="mt-14 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{s.ladderHeading}</h3>
      <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted">{s.ladderIntro}</p>
      {s.ladderPhases.map((phase, phaseIndex) => {
        // Levels are numbered across both phases (1–8).
        const first = s.ladderPhases.slice(0, phaseIndex).reduce((n, p) => n + p.levels.length, 1);
        return (
          <div key={phase.title} className="mt-8">
            <h4 className="text-base font-semibold text-fg">{phase.title}</h4>
            <ol className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {phase.levels.map((level, i) => (
                <LadderStep key={level.title} step={first + i} level={level} />
              ))}
            </ol>
          </div>
        );
      })}

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

/** One level of the career ladder: number, title, focus, what you learn and what it takes to move up. */
function LadderStep({ step, level }: { step: number; level: LandingLadderLevel }) {
  const labels = LANDING.careers.ladderLabels;
  return (
    <li className="flex min-w-0 flex-col rounded-xl border border-border bg-surface p-5 shadow-card">
      <div className="flex items-center gap-3">
        <span className="kpi-number inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-sm text-primary-fg" aria-hidden>
          {step}
        </span>
        <h5 className="min-w-0 text-sm font-semibold text-fg">
          <span className="sr-only">Level {step}: </span>
          {level.title}
        </h5>
      </div>
      <p className="mt-3 text-sm font-medium leading-relaxed text-fg">{level.focus}</p>
      <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{labels.learn}</p>
      <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-muted">
        {level.learn.map((item) => (
          <li key={item} className="flex gap-1.5">
            <span className="mt-[7px] h-1 w-1 shrink-0 rounded-full bg-primary" aria-hidden />
            <span className="min-w-0">{item}</span>
          </li>
        ))}
      </ul>
      {level.next.length > 0 && (
        <>
          <p className="mt-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{labels.next}</p>
          <ul className="mt-1.5 space-y-1 text-xs leading-relaxed text-muted">
            {level.next.map((item) => (
              <li key={item} className="flex gap-1.5">
                <ArrowRight className="mt-0.5 h-3 w-3 shrink-0 text-primary" aria-hidden />
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </li>
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
        <h3 className="text-xl font-semibold text-fg">{s.safetyHeading}</h3>
        <p className="mt-1 text-sm text-muted">{s.safetyIntro}</p>
        <ul className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {s.safety.map((f) => (
            <FeatureCard key={f.title} {...f} as="h4" surface="bg" />
          ))}
        </ul>
      </div>
    </Section>
  );
}

function CtaBand({ signedIn, appHref }: { signedIn: boolean; appHref: string }) {
  const c = signedIn ? LANDING.cta.signedIn : LANDING.cta.signedOut;
  return (
    <section aria-labelledby="cta-title" className="relative overflow-hidden bg-ink text-ink-fg">
      <BrandBackdrop intensity="soft" variant="ink" vignette="left" />
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
