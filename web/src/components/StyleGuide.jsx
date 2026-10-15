// Living style guide — `#/styleguide`. Every ui/ component, the tokens, the
// accent budget and the rules, with LTR/RTL + light/dark switches. Phase-2
// screens are reviewed against this page; it is not linked from the product UI.
import { useState } from 'react';
import { usePrefs, setPrefs } from '../lib/prefs.js';
import { langDir } from '../lib/langs.js';
import { toast, toastError, toastSuccess } from '../lib/toast.js';
import { cn } from '../lib/utils.js';
import { Toaster } from './ui/toast.jsx';
import { Button } from './ui/button.jsx';
import { Badge, StatusDot } from './ui/badge.jsx';
import { Kbd } from './ui/kbd.jsx';
import { Input, Textarea } from './ui/input.jsx';
import { Label } from './ui/label.jsx';
import { Separator } from './ui/separator.jsx';
import { Skeleton } from './ui/skeleton.jsx';
import { Switch } from './ui/switch.jsx';
import { Checkbox } from './ui/checkbox.jsx';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs.jsx';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './ui/collapsible.jsx';
import { ScrollArea } from './ui/scroll-area.jsx';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel } from './ui/select.jsx';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover.jsx';
import { Tip } from './ui/tooltip.jsx';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator,
  DropdownMenuShortcut, DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent, DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup, DropdownMenuRadioItem,
} from './ui/dropdown-menu.jsx';
import { ContextMenu, ContextMenuTrigger, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuShortcut } from './ui/context-menu.jsx';
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription, DialogClose } from './ui/dialog.jsx';
import {
  AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogFooter, AlertDialogTitle,
  AlertDialogDescription, AlertDialogAction, AlertDialogCancel,
} from './ui/alert-dialog.jsx';
import { Sheet, SheetTrigger, SheetContent, SheetHeader, SheetTitle, SheetDescription } from './ui/sheet.jsx';
import { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem, CommandShortcut } from './ui/command.jsx';
import { ChevronDownIcon, MoreHorizontalIcon, PlusIcon, SearchIcon, ArchiveIcon, TrashIcon, PencilIcon, CopyIcon, SettingsIcon, GitBranchIcon } from 'lucide-react';

const COPY = {
  en: {
    title: 'Style guide',
    lead: 'Every ui/ component and token, live. Flip theme and direction above; nothing here is wired to the product.',
    tokens: 'Tokens', neutral: 'Neutral ramp', status: 'Status tones', type: 'Type scale', radii: 'Radii', elev: 'Elevation', motion: 'Motion',
    buttons: 'Buttons', fields: 'Fields', chips: 'Badges, dots, kbd', menus: 'Menus, popovers, tooltips', overlays: 'Dialogs, sheets, command, toasts',
    nav: 'Tabs, collapsible, scroll, skeleton', budget: 'Accent budget', patterns: 'Patterns', rtl: 'RTL checklist',
    sample: 'The quick brown fox', hint: 'Right-click here for a context menu',
  },
  he: {
    title: 'מדריך סגנון',
    lead: 'כל רכיבי ui/ והטוקנים, חי. מחליפים ערכה וכיוון למעלה; שום דבר כאן לא מחובר למוצר.',
    tokens: 'טוקנים', neutral: 'רמפה ניטרלית', status: 'גווני סטטוס', type: 'סולם טיפוגרפיה', radii: 'רדיוסים', elev: 'עומק', motion: 'תנועה',
    buttons: 'כפתורים', fields: 'שדות', chips: 'תגיות, נקודות, קיצורים', menus: 'תפריטים, פופאובר, טולטיפ', overlays: 'דיאלוגים, גיליונות, פקודות, טוסטים',
    nav: 'טאבים, קיפול, גלילה, שלד', budget: 'תקציב הצבע', patterns: 'דפוסים', rtl: 'רשימת RTL',
    sample: 'שלום עולם, זה טקסט לדוגמה', hint: 'לחיצה ימנית כאן לתפריט הקשר',
  },
};

function Section({ id, title, children }) {
  return (
    <section id={id} className="border-t border-border py-8 first:border-t-0">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      <div className="flex flex-col gap-5">{children}</div>
    </section>
  );
}
const Row = ({ label, children, className }) => (
  <div className="flex flex-col gap-2">
    {label && <div className="text-xs text-muted-foreground">{label}</div>}
    <div className={cn('flex flex-wrap items-center gap-2', className)}>{children}</div>
  </div>
);
const Code = ({ children }) => (
  <pre dir="ltr" className="overflow-x-auto rounded-lg border border-border bg-muted p-3 text-left font-mono text-xs leading-relaxed whitespace-pre">{children}</pre>
);

const SWATCH = [
  ['bg', 'background'], ['panel', 'card / popover'], ['rail', 'rail'], ['hover', 'hover / muted'], ['sel2', 'pressed'],
  ['fg', 'text'], ['fg2', 'text 2'], ['fgdim', 'text 3 (muted)'], ['faint', 'decorative'], ['hair', 'hairline'], ['border', 'control border'],
];
const TONES = ['ok', 'warn', 'err', 'info', 'violet'];

export default function StyleGuide() {
  const prefs = usePrefs();
  const lang = prefs.language === 'he' ? 'he' : 'en';
  const c = COPY[lang];
  const [radio, setRadio] = useState('claude');
  const [checks, setChecks] = useState({ a: true, b: false });
  const [cmdOpen, setCmdOpen] = useState(false);
  const [open, setOpen] = useState(true);
  const dark = prefs.theme === 'dark';

  return (
    <div className="min-h-full bg-background text-foreground" data-styleguide>
      <Toaster />
      <header className="sticky top-0 z-30 flex flex-wrap items-center gap-3 border-b border-border bg-background/95 px-4 py-2.5 backdrop-blur">
        <span className="text-base font-semibold">{c.title}</span>
        <span className="hidden text-xs text-muted-foreground sm:inline">{c.lead}</span>
        <div className="ms-auto flex items-center gap-1.5">
          <Tabs value={dark ? 'dark' : 'light'} onValueChange={(v) => setPrefs({ theme: v })}>
            <TabsList variant="segmented">
              <TabsTrigger value="light">Light</TabsTrigger>
              <TabsTrigger value="dark">Dark</TabsTrigger>
            </TabsList>
          </Tabs>
          <Tabs value={langDir(prefs.language)} onValueChange={(v) => setPrefs({ language: v === 'rtl' ? 'he' : 'en' })}>
            <TabsList variant="segmented">
              <TabsTrigger value="ltr">LTR</TabsTrigger>
              <TabsTrigger value="rtl">RTL</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 pb-24">
        <Section id="tokens" title={c.tokens}>
          <Row label={c.neutral} className="gap-3">
            {SWATCH.map(([k, name]) => (
              <div key={k} className="flex w-24 flex-col gap-1">
                <div className="h-10 rounded-md border border-border" style={{ background: `var(--hb-${k})` }} />
                <div dir="ltr" className="text-2xs font-medium">--hb-{k}</div>
                <div className="text-2xs text-muted-foreground">{name}</div>
              </div>
            ))}
          </Row>
          <Row label={c.status} className="gap-3">
            {TONES.map((k) => (
              <div key={k} className="flex flex-col gap-1">
                <div className="flex h-10 w-24 items-center justify-center rounded-md border text-xs font-medium" style={{ background: `var(--hb-${k}-bg)`, borderColor: `var(--hb-${k}-line)`, color: `var(--hb-${k})` }}>{k}</div>
                <div className="text-2xs text-muted-foreground">tone · bg · line</div>
              </div>
            ))}
            <div className="flex flex-col gap-1">
              <div className="h-10 w-24 rounded-md" style={{ background: 'var(--accent-fill)' }} />
              <div className="text-2xs text-muted-foreground">accent (primary only)</div>
            </div>
          </Row>
          <Row label={c.type} className="flex-col items-start gap-1">
            {[['text-2xs', '11 caption'], ['text-xs', '12 secondary'], ['text-sm', '13 body'], ['text-base', '14 emphasis'], ['text-lg', '16 section'], ['text-xl', '20 page']].map(([cls, n]) => (
              <div key={cls} className={cn(cls, 'flex items-baseline gap-3')}>
                <span className="w-24 text-2xs text-muted-foreground">{n}</span>
                <span>{c.sample} <span className="tabular-nums">0123456789</span></span>
              </div>
            ))}
            <div dir="ltr" className="font-mono text-xs">mono — only for code: git switch -c feat/x</div>
          </Row>
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-3">
            <Row label={c.radii}>
              {[['sm', 4], ['md', 6], ['lg', 8], ['xl', 12]].map(([k, px]) => (
                <div key={k} className={`flex size-14 items-center justify-center border border-border bg-muted text-2xs rounded-${k}`}>{px}</div>
              ))}
            </Row>
            <Row label={c.elev}>
              <div className="flex size-14 items-center justify-center rounded-lg border border-border bg-card text-2xs shadow-card">card</div>
              <div className="flex size-14 items-center justify-center rounded-lg bg-popover text-2xs shadow-pop">pop</div>
              <div className="flex size-14 items-center justify-center rounded-xl bg-popover text-2xs shadow-dialog">dialog</div>
            </Row>
            <Row label={c.motion}>
              {[100, 150, 200].map((ms) => (
                <button key={ms} type="button" className="group flex size-14 items-center justify-center rounded-lg border border-border bg-muted text-2xs" onClick={(e) => e.currentTarget.firstChild.animate([{ transform: 'scale(1)' }, { transform: 'scale(1.3)' }, { transform: 'scale(1)' }], { duration: ms * 4, easing: 'cubic-bezier(.2,.7,.2,1)' })}>
                  <span className="block">{ms}ms</span>
                </button>
              ))}
            </Row>
          </div>
        </Section>

        <Section id="buttons" title={c.buttons}>
          <Row label="variant"><Button variant="primary">Primary (the one)</Button><Button>Default</Button><Button variant="outline">Outline</Button><Button variant="ghost">Ghost</Button><Button variant="destructive">Destructive</Button><Button variant="link">Link</Button><Button disabled>Disabled</Button></Row>
          <Row label="size"><Button size="xs">xs</Button><Button size="sm">sm</Button><Button>default</Button><Button size="lg">lg</Button><Button size="touch">touch 44</Button></Row>
          <Row label="icon (44px under a coarse pointer; icon-touch always)">
            <Tip label="Add" shortcut="N"><Button size="icon-xs" variant="ghost" aria-label="Add"><PlusIcon /></Button></Tip>
            <Button size="icon-sm" variant="ghost" aria-label="More"><MoreHorizontalIcon /></Button>
            <Button size="icon" variant="outline" aria-label="Search"><SearchIcon /></Button>
            <Button size="icon-lg" aria-label="Settings"><SettingsIcon /></Button>
            <Button size="icon-touch" variant="outline" aria-label="Copy"><CopyIcon /></Button>
            <Button variant="primary"><PlusIcon />New session <Kbd className="border-[color-mix(in_oklab,var(--on-accent)_30%,transparent)] bg-transparent text-[color-mix(in_oklab,var(--on-accent)_75%,transparent)]">N</Kbd></Button>
          </Row>
        </Section>

        <Section id="fields" title={c.fields}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5"><Label htmlFor="sg-in">Name</Label><Input id="sg-in" placeholder="my-session" /></div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="sg-in2">Path (LTR value)</Label><Input id="sg-in2" dir="ltr" defaultValue="~/work/app/src" className="text-left" /></div>
            <div className="flex flex-col gap-1.5">
              <Label>Select</Label>
              <Select defaultValue="sonnet">
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectGroup><SelectLabel>Models</SelectLabel><SelectItem value="sonnet">Sonnet</SelectItem><SelectItem value="opus">Opus</SelectItem><SelectItem value="haiku">Haiku</SelectItem></SelectGroup>
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-1.5"><Label htmlFor="sg-ta">Textarea</Label><Textarea id="sg-ta" placeholder="…" /></div>
          </div>
          <Row>
            <label className="flex items-center gap-2 text-sm"><Switch defaultChecked /> Switch on</label>
            <label className="flex items-center gap-2 text-sm"><Switch /> Switch off</label>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={checks.a} onCheckedChange={(v) => setChecks((s) => ({ ...s, a: v }))} /> Checked</label>
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={checks.b} onCheckedChange={(v) => setChecks((s) => ({ ...s, b: v }))} /> Unchecked</label>
          </Row>
        </Section>

        <Section id="chips" title={c.chips}>
          <Row label="Badge — neutral; colour lives in the dot only">
            <Badge>Plain</Badge><Badge variant="outline">Outline</Badge><Badge status="ok">Ready</Badge><Badge status="warn">Needs you</Badge><Badge status="err">Failed</Badge><Badge status="info">Working</Badge><Badge status="violet">Review</Badge>
            <Badge mono variant="outline"><GitBranchIcon />feat/redesign</Badge><Badge variant="solid">3</Badge>
          </Row>
          <Row label="StatusDot"><StatusDot status="ok" /><StatusDot status="warn" pulse /><StatusDot status="err" /><StatusDot status="info" /><StatusDot status="idle" /></Row>
          <Row label="Kbd"><Kbd>⌘</Kbd><Kbd>K</Kbd><Kbd>⌘⇧↵</Kbd></Row>
        </Section>

        <Section id="menus" title={c.menus}>
          <Row>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label="More"><MoreHorizontalIcon /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>Session</DropdownMenuLabel>
                <DropdownMenuItem><PencilIcon />Rename<DropdownMenuShortcut>F2</DropdownMenuShortcut></DropdownMenuItem>
                <DropdownMenuItem><CopyIcon />Copy link</DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger><ArchiveIcon />Move to</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem>Folder one</DropdownMenuItem><DropdownMenuItem>Folder two</DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuCheckboxItem checked={checks.a} onCheckedChange={(v) => setChecks((s) => ({ ...s, a: v }))}>Show archived</DropdownMenuCheckboxItem>
                <DropdownMenuRadioGroup value={radio} onValueChange={setRadio}>
                  <DropdownMenuRadioItem value="claude">Claude</DropdownMenuRadioItem><DropdownMenuRadioItem value="codex">Codex</DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive"><TrashIcon />Delete<DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut></DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Popover>
              <PopoverTrigger asChild><Button variant="outline">Model · Sonnet <ChevronDownIcon /></Button></PopoverTrigger>
              <PopoverContent align="start" className="w-64 p-0">
                <Command>
                  <CommandInput placeholder="Search…" />
                  <CommandList>
                    <CommandEmpty>No results</CommandEmpty>
                    <CommandGroup heading="Models"><CommandItem>Sonnet</CommandItem><CommandItem>Opus</CommandItem><CommandItem>Haiku</CommandItem></CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>

            <Tip label="A tooltip" shortcut="⌘K"><Button variant="ghost">Hover or focus me</Button></Tip>
          </Row>
          <ContextMenu>
            <ContextMenuTrigger className="flex h-20 items-center justify-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">{c.hint}</ContextMenuTrigger>
            <ContextMenuContent className="w-52">
              <ContextMenuItem><CopyIcon />Copy<ContextMenuShortcut>⌘C</ContextMenuShortcut></ContextMenuItem>
              <ContextMenuItem><PencilIcon />Edit</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive"><TrashIcon />Delete</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </Section>

        <Section id="overlays" title={c.overlays}>
          <Row>
            <Dialog>
              <DialogTrigger asChild><Button variant="outline">Dialog</Button></DialogTrigger>
              <DialogContent>
                <DialogHeader><DialogTitle>Rename session</DialogTitle><DialogDescription>Shown in the rail and the tab bar.</DialogDescription></DialogHeader>
                <Input defaultValue="redesign-foundation" />
                <DialogFooter><DialogClose asChild><Button>Cancel</Button></DialogClose><DialogClose asChild><Button variant="primary">Save</Button></DialogClose></DialogFooter>
              </DialogContent>
            </Dialog>
            <AlertDialog>
              <AlertDialogTrigger asChild><Button variant="outline">Alert dialog</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader><AlertDialogTitle>Delete this session?</AlertDialogTitle><AlertDialogDescription>The worktree and branch are removed. This cannot be undone.</AlertDialogDescription></AlertDialogHeader>
                <AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive">Delete</AlertDialogAction></AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
            <Sheet>
              <SheetTrigger asChild><Button variant="outline">Bottom sheet</Button></SheetTrigger>
              <SheetContent side="bottom">
                <SheetHeader><SheetTitle>Model &amp; effort</SheetTitle><SheetDescription>The phone form of a popover.</SheetDescription></SheetHeader>
                <div className="flex flex-col gap-1">{['Sonnet', 'Opus', 'Haiku'].map((m) => <Button key={m} variant="ghost" size="touch" className="justify-start">{m}</Button>)}</div>
              </SheetContent>
            </Sheet>
            <Sheet>
              <SheetTrigger asChild><Button variant="outline">Side sheet (start)</Button></SheetTrigger>
              <SheetContent side="start"><SheetHeader><SheetTitle>Rail</SheetTitle><SheetDescription>Slides from the start edge (right in RTL).</SheetDescription></SheetHeader></SheetContent>
            </Sheet>
            <Button variant="outline" onClick={() => setCmdOpen(true)}>Command palette <Kbd>⌘K</Kbd></Button>
            <CommandDialog open={cmdOpen} onOpenChange={setCmdOpen} title="Command palette">
              <CommandInput placeholder="Type a command…" />
              <CommandList>
                <CommandEmpty>No results</CommandEmpty>
                <CommandGroup heading="Sessions"><CommandItem onSelect={() => setCmdOpen(false)}>Open redesign-foundation<CommandShortcut>⌘1</CommandShortcut></CommandItem></CommandGroup>
                <CommandGroup heading="Actions"><CommandItem onSelect={() => setCmdOpen(false)}><PlusIcon />New session<CommandShortcut>⌘N</CommandShortcut></CommandItem></CommandGroup>
              </CommandList>
            </CommandDialog>
          </Row>
          <Row label="Toasts (the app's own store: toast / toastSuccess / toastError)">
            <Button size="sm" onClick={() => toast('Link copied')}>Info</Button>
            <Button size="sm" onClick={() => toastSuccess('Saved')}>Success</Button>
            <Button size="sm" onClick={() => toastError('Could not reach the host')}>Error</Button>
            <Button size="sm" onClick={() => toast('Session archived', { action: { label: 'Undo', onClick: () => toast('Restored') } })}>With action</Button>
          </Row>
        </Section>

        <Section id="nav" title={c.nav}>
          <Tabs defaultValue="chat">
            <TabsList><TabsTrigger value="chat">Chat</TabsTrigger><TabsTrigger value="changes">Changes <span className="tabular-nums text-muted-foreground">12</span></TabsTrigger><TabsTrigger value="machine">Machine</TabsTrigger></TabsList>
            <TabsContent value="chat" className="py-3 text-sm text-muted-foreground">Tab bodies are plain; the active tab gets a 2px ink underline, never the accent.</TabsContent>
            <TabsContent value="changes" className="py-3 text-sm text-muted-foreground">Changes content.</TabsContent>
            <TabsContent value="machine" className="py-3 text-sm text-muted-foreground">Machine content.</TabsContent>
          </Tabs>
          <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border border-border">
            <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm font-medium coarse:min-h-11"><ChevronDownIcon className={cn('size-4 transition-transform', !open && '-rotate-90 rtl:rotate-90')} />Tool calls (3)</CollapsibleTrigger>
            <CollapsibleContent className="border-t border-border px-3 py-2 text-sm text-muted-foreground">Read · Edit · Bash</CollapsibleContent>
          </Collapsible>
          <ScrollArea className="h-24 rounded-lg border border-border" horizontal>
            <pre dir="ltr" className="p-3 text-left font-mono text-xs leading-relaxed whitespace-pre">{Array.from({ length: 12 }, (_, i) => `${String(i + 1).padStart(2)}  const line${i} = compute(${i}) // a long line of code that scrolls horizontally in LTR even under RTL`).join('\n')}</pre>
          </ScrollArea>
          <Row label="Skeleton / Separator"><Skeleton className="h-4 w-40" /><Skeleton className="size-8 rounded-full" /><Separator className="w-24" /></Row>
        </Section>

        <Section id="budget" title={c.budget}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-border p-4">
              <div className="mb-3 text-sm font-semibold">One view, one primary</div>
              <div className="flex flex-col gap-2">
                <div className="row-selected flex items-center gap-2 rounded-md px-3 py-2 text-sm"><StatusDot status="warn" pulse />redesign-foundation<Badge className="ms-auto" mono variant="outline">feat/x</Badge></div>
                <div className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-muted"><StatusDot status="ok" />docs-pass<Badge className="ms-auto">Ready</Badge></div>
                <div className="flex gap-2"><Button variant="primary">Approve</Button><Button>Reject</Button><Button variant="ghost">Later</Button></div>
              </div>
            </div>
            <ul className="list-disc ps-5 text-sm leading-relaxed text-muted-foreground">
              <li><b className="text-foreground">Accent only on:</b> the one primary action, focus rings, the logo, a thin selected-row indicator (<code>.row-selected</code>).</li>
              <li>Buttons, tabs, chips, badges, toggles, links: neutral. Status = tiny dot + word.</li>
              <li>Amber is for “waiting for you” only.</li>
              <li>Settings → Accent colour still rebrands the accent (<code>--color-brand</code>).</li>
            </ul>
          </div>
        </Section>

        <Section id="patterns" title={c.patterns}>
          <Code>{`// menu
<DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon-sm" aria-label="More"><MoreHorizontalIcon/></Button></DropdownMenuTrigger>
  <DropdownMenuContent align="end"><DropdownMenuItem onSelect={…}>…<DropdownMenuShortcut>⌘⌫</DropdownMenuShortcut></DropdownMenuItem></DropdownMenuContent></DropdownMenu>

// the one primary action of a view
<Button variant="primary">Create PR</Button>      // everything else: default | outline | ghost

// list row (selected = thin start-edge indicator, never a coloured fill)
<div className={cn('flex min-h-8 items-center gap-2 rounded-md px-2 hover:bg-muted', selected && 'row-selected')}>
  <StatusDot status="warn" pulse /><span className="min-w-0 flex-1 truncate">{title}</span><Badge mono>{branch}</Badge></div>

// chip: <Badge status="ok">Ready</Badge>   // tooltip instead of title=: <Tip label="Archive" shortcut="⌘⌫">…</Tip>`}</Code>
        </Section>

        <Section id="rtl" title={c.rtl}>
          <ul className="list-disc ps-5 text-sm leading-relaxed text-muted-foreground">
            <li>Logical utilities only: <code>ms- me- ps- pe- start- end- text-start border-s rtl:</code>. Never <code>ml- pl- left- text-left</code> in new code.</li>
            <li>Directional icons (chevrons, arrows): <code>rtl:rotate-180</code> (or <code>.mirror-rtl</code>).</li>
            <li>Code, paths, URLs, branch names: <code>dir=&quot;ltr&quot;</code> or <code>&lt;bdi&gt;</code>; scrollable code gets <code>dir=&quot;ltr&quot;</code> on the scroller.</li>
            <li>Radix reads direction from <code>UiProvider</code> (already at the root) — do not add <code>dir</code> props to menus.</li>
            <li>Portals inherit <code>&lt;html dir&gt;</code>; Hebrew letter-spacing is 0 (global rule).</li>
          </ul>
          <div className="rounded-lg border border-border p-3 text-sm">{lang === 'he' ? <>טקסט עברי עם <bdi dir="ltr">git switch -c feat/x</bdi> באמצע, ו־<bdi dir="ltr">~/work/app</bdi>.</> : <>English text with <bdi>עברית</bdi> inside.</>}</div>
        </Section>
      </main>
    </div>
  );
}
