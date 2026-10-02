import { useQuery } from '@tanstack/react-query';
import { BookOpen, ChevronDown, Eye, FileText, FileUp, Globe, HelpCircle, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../../auth/AuthContext';
import { useConfirm } from '../../components/feedback-context';
import { Drawer, MenuItem, Modal, Popover } from '../../components/overlay';
import { DocumentStatusBadge } from '../../components/status';
import {
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  cx,
  EmptyState,
  ErrorBanner,
  Field,
  IconButton,
  Input,
  NumberInput,
  PageHeader,
  Select,
  SkeletonRows,
  Spinner,
  Table,
  TD,
  Textarea,
  TH,
  Toggle,
} from '../../components/ui';
import { api, del, get, patch, post } from '../../lib/api';
import { categoryLabel, formatBytes, formatNumber, timeAgo } from '../../lib/format';
import { useAction } from '../../lib/mutations';
import { roleAtLeast, useKnowledgeBases, useKnowledgeLanguages } from '../../lib/queries';
import { Link, navigate } from '../../lib/router';
import {
  DOCUMENT_CATEGORIES,
  type Chunk,
  type DocumentCategory,
  type FaqItem,
  type KbDocument,
  type KnowledgeBase,
  type KnowledgeLanguage,
  type RefreshInterval,
  type SearchResult,
} from '../../lib/types';

type DialogState =
  | { kind: 'kb'; kb?: KnowledgeBase }
  | { kind: 'text'; doc?: KbDocument }
  | { kind: 'faq'; doc?: KbDocument }
  | { kind: 'url'; doc?: KbDocument }
  | { kind: 'upload' }
  | null;

const SOURCE_ICON = { text: FileText, faq: HelpCircle, url: Globe, file: FileUp } as const;

const REFRESH_LABEL = { 24: 'daily', 168: 'weekly' } as const;

function languageName(value: string, languages: KnowledgeLanguage[] | undefined): string {
  return languages?.find((l) => l.value === value)?.label ?? (value === 'simple' ? 'Any language' : value.charAt(0).toUpperCase() + value.slice(1));
}

/** "refreshes daily (last 3h ago, next in 21h)" for website documents on a schedule. */
function refreshNote(d: KbDocument): string | null {
  if (d.sourceType !== 'url' || !d.refreshIntervalHours) return null;
  const times = [
    d.lastIngestedAt && `last ${timeAgo(d.lastIngestedAt)}`,
    d.nextRefreshAt && `next ${new Date(d.nextRefreshAt).getTime() <= Date.now() ? 'due now' : timeAgo(d.nextRefreshAt)}`,
  ].filter(Boolean);
  return `refreshes ${REFRESH_LABEL[d.refreshIntervalHours]}${times.length ? ` (${times.join(', ')})` : ''}`;
}

export function KnowledgePage({ kbId }: { kbId: string | null }) {
  const kbs = useKnowledgeBases();
  const { role } = useAuth();
  const isAdmin = roleAtLeast(role, 'admin');
  const [dialog, setDialog] = useState<DialogState>(null);

  useEffect(() => {
    const first = kbs.data?.[0];
    if (first && (!kbId || !kbs.data?.some((k) => k.id === kbId))) navigate(`/knowledge/${first.id}`, { replace: true });
  }, [kbId, kbs.data]);

  const kb = kbs.data?.find((k) => k.id === kbId) ?? null;

  return (
    <div>
      <PageHeader
        title="Knowledge"
        description="What your assistants know. They search it to answer questions and cite the source."
        actions={
          isAdmin && (
            <Button icon={<Plus className="size-4" />} onClick={() => setDialog({ kind: 'kb' })}>
              New knowledge base
            </Button>
          )
        }
      />
      <div className="grid grid-cols-1 gap-6 px-4 py-6 sm:px-8 lg:grid-cols-[240px_1fr]">
        <nav aria-label="Knowledge bases" className="space-y-1">
          {kbs.isLoading ? (
            <SkeletonRows rows={3} className="p-0" />
          ) : kbs.error ? (
            <ErrorBanner error={kbs.error} />
          ) : (
            kbs.data?.map((k) => (
              <Link
                key={k.id}
                to={`/knowledge/${k.id}`}
                aria-current={k.id === kbId ? 'page' : undefined}
                className={cx('flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-body-sm transition-colors', k.id === kbId ? 'bg-accent-soft font-semibold text-accent-text' : 'font-medium text-fg-2 hover:bg-surface-2 hover:text-fg')}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <BookOpen className="size-4 shrink-0" aria-hidden />
                  <span className="truncate">{k.name}</span>
                </span>
                <span className="text-label text-muted tabular-nums">{k.documentCount}</span>
              </Link>
            ))
          )}
          {kbs.data?.length === 0 && (
            <p className="px-3 py-2 text-body-sm text-muted">No knowledge bases yet.</p>
          )}
        </nav>
        <div className="min-w-0 space-y-6">
          {kb ? (
            <>
              <DocumentsCard kb={kb} isAdmin={isAdmin} onDialog={setDialog} />
              <RetrievalTester kbs={kbs.data ?? []} currentKbId={kb.id} />
            </>
          ) : kbs.data?.length === 0 ? (
            <Card>
              <EmptyState
                icon={<BookOpen className="size-5" />}
                title="Create your first knowledge base"
                description="Group FAQs, web pages and documents. Then connect it to a bot on the bot's Knowledge tab."
                action={isAdmin && <Button variant="primary" onClick={() => setDialog({ kind: 'kb' })}>New knowledge base</Button>}
              />
            </Card>
          ) : null}
        </div>
      </div>

      {dialog?.kind === 'kb' && <KbDialog kb={dialog.kb} onClose={() => setDialog(null)} />}
      {kb && dialog?.kind === 'text' && <TextDocDialog kbId={kb.id} doc={dialog.doc} onClose={() => setDialog(null)} />}
      {kb && dialog?.kind === 'faq' && <FaqDocDialog kbId={kb.id} doc={dialog.doc} onClose={() => setDialog(null)} />}
      {kb && dialog?.kind === 'url' && <UrlDocDialog kbId={kb.id} doc={dialog.doc} onClose={() => setDialog(null)} />}
      {kb && dialog?.kind === 'upload' && <UploadDialog kbId={kb.id} onClose={() => setDialog(null)} />}
    </div>
  );
}

function DocumentsCard({ kb, isAdmin, onDialog }: { kb: KnowledgeBase; isAdmin: boolean; onDialog: (d: DialogState) => void }) {
  const confirm = useConfirm();
  const languages = useKnowledgeLanguages();
  const [chunksDoc, setChunksDoc] = useState<KbDocument | null>(null);
  const docs = useQuery({
    queryKey: ['documents', kb.id],
    queryFn: () => get<KbDocument[]>(`/v1/knowledge-bases/${kb.id}/documents`),
    // Poll while anything is still being ingested.
    refetchInterval: (query) => (query.state.data?.some((d) => d.status === 'pending' || d.status === 'processing') ? 3000 : false),
  });
  const invalidate = [['documents', kb.id], ['kbs']];
  const deleteKb = useAction(() => del(`/v1/knowledge-bases/${kb.id}`), { invalidate: [['kbs'], ['bots']], success: 'Knowledge base deleted', onSuccess: () => navigate('/knowledge', { replace: true }) });
  const reingest = useAction((id: string) => post<KbDocument>(`/v1/documents/${id}/reingest`), { invalidate, success: 'Re-ingesting document' });
  const remove = useAction((id: string) => del(`/v1/documents/${id}`), { invalidate, success: 'Document deleted' });
  const processing = docs.data?.filter((d) => d.status === 'pending' || d.status === 'processing').length ?? 0;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            {kb.name}
            <Badge>{languageName(kb.language, languages.data)}</Badge>
            {processing > 0 && (
              <Badge tone="amber">
                <Spinner className="size-3" /> {processing} processing
              </Badge>
            )}
          </span>
        }
        description={kb.description || 'No description'}
        actions={
          isAdmin && (
            <>
              <Popover
                label="Knowledge base actions"
                trigger={({ toggle, open, id }) => (
                  <IconButton label="Knowledge base actions" size="sm" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem icon={<Pencil className="size-3.5" />} onClick={() => { close(); onDialog({ kind: 'kb', kb }); }}>
                      Edit details
                    </MenuItem>
                    <MenuItem
                      danger
                      icon={<Trash2 className="size-3.5" />}
                      onClick={async () => {
                        close();
                        if (await confirm({ title: `Delete “${kb.name}”?`, message: `Deletes ${kb.documentCount} document(s) and removes it from every bot.`, confirmLabel: 'Delete', danger: true })) deleteKb.mutate();
                      }}
                    >
                      Delete knowledge base
                    </MenuItem>
                  </>
                )}
              </Popover>
              <Popover
                label="Add document"
                trigger={({ toggle, open, id }) => (
                  <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
                    Add content <ChevronDown className="size-3.5" />
                  </Button>
                )}
              >
                {(close) => (
                  <>
                    <MenuItem icon={<HelpCircle className="size-3.5" />} onClick={() => { close(); onDialog({ kind: 'faq' }); }}>
                      FAQs
                    </MenuItem>
                    <MenuItem icon={<FileText className="size-3.5" />} onClick={() => { close(); onDialog({ kind: 'text' }); }}>
                      Text
                    </MenuItem>
                    <MenuItem icon={<Globe className="size-3.5" />} onClick={() => { close(); onDialog({ kind: 'url' }); }}>
                      Web page
                    </MenuItem>
                    <MenuItem icon={<FileUp className="size-3.5" />} onClick={() => { close(); onDialog({ kind: 'upload' }); }}>
                      Upload a file
                    </MenuItem>
                  </>
                )}
              </Popover>
            </>
          )
        }
      />
      {docs.isLoading ? (
        <SkeletonRows rows={4} />
      ) : docs.error ? (
        <ErrorBanner error={docs.error} className="m-4" />
      ) : !docs.data?.length ? (
        <EmptyState
          icon={<FileText className="size-5" />}
          title="No documents yet"
          description="Add FAQs, a page URL or upload a PDF — the assistant will search them to answer questions."
          action={
            isAdmin && (
              <div className="flex gap-2">
                <Button size="sm" onClick={() => onDialog({ kind: 'faq' })}>Add FAQs</Button>
                <Button size="sm" onClick={() => onDialog({ kind: 'url' })}>Add a web page</Button>
                <Button size="sm" onClick={() => onDialog({ kind: 'upload' })}>Upload a file</Button>
              </div>
            )
          }
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <TH>Document</TH>
              <TH>Category</TH>
              <TH>Status</TH>
              <TH className="text-right">Chunks</TH>
              <TH className="text-right">Tokens</TH>
              <TH>Updated</TH>
              <TH>
                <span className="sr-only">Actions</span>
              </TH>
            </tr>
          </thead>
          <tbody>
            {docs.data.map((d) => {
              const Icon = SOURCE_ICON[d.sourceType] ?? FileText;
              const editable = d.sourceType === 'text' || d.sourceType === 'faq' || d.sourceType === 'url';
              return (
                <tr key={d.id}>
                  <TD className="max-w-md">
                    <div className="flex items-start gap-2">
                      <Icon className="mt-0.5 size-4 shrink-0 text-muted" aria-label={d.sourceType} />
                      <div className="min-w-0">
                        <p className="truncate font-medium text-fg">{d.title}</p>
                        <p className="truncate text-caption text-muted">
                          {d.sourceType === 'url' && d.sourceUri ? (
                            <>
                              <a href={d.sourceUri} target="_blank" rel="noreferrer" className="hover:underline">
                                {d.sourceUri}
                                {d.options?.crawl ? ` · crawl up to ${d.options.maxPages ?? 10} pages` : ''}
                              </a>
                              {refreshNote(d) && ` · ${refreshNote(d)}`}
                            </>
                          ) : d.sourceType === 'file' ? (
                            `${d.mimeType ?? 'file'} · ${formatBytes(d.fileSize)}`
                          ) : d.sourceType === 'faq' ? (
                            `${d.faq?.length ?? 0} questions`
                          ) : (
                            'Text'
                          )}
                        </p>
                        {d.status === 'failed' && d.error && (
                          <p className="mt-0.5 text-caption text-danger-text">
                            {d.chunkCount > 0 && d.lastIngestedAt
                              ? `${d.sourceType === 'url' ? 'Last fetch' : 'Last update'} failed (${d.error}). Still answering from the version from ${timeAgo(d.lastIngestedAt)}.`
                              : d.error}
                          </p>
                        )}
                      </div>
                    </div>
                  </TD>
                  <TD className="text-fg-2">{categoryLabel(d.category)}</TD>
                  <TD>
                    <DocumentStatusBadge status={d.status} />
                  </TD>
                  <TD className="text-right tabular-nums">{formatNumber(d.chunkCount)}</TD>
                  <TD className="text-right tabular-nums">{formatNumber(d.tokenCount)}</TD>
                  <TD className="whitespace-nowrap text-muted">{timeAgo(d.updatedAt)}</TD>
                  <TD className="text-right">
                    <Popover
                      portal
                      label={`Actions for ${d.title}`}
                      trigger={({ toggle, open, id }) => (
                        <IconButton label={`Actions for ${d.title}`} size="sm" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
                          <MoreHorizontal className="size-4" />
                        </IconButton>
                      )}
                    >
                      {(close) => (
                        <>
                          <MenuItem icon={<Eye className="size-3.5" />} onClick={() => { close(); setChunksDoc(d); }}>
                            View chunks
                          </MenuItem>
                          {isAdmin && editable && (
                            <MenuItem icon={<Pencil className="size-3.5" />} onClick={() => { close(); onDialog({ kind: d.sourceType as 'text' | 'faq' | 'url', doc: d }); }}>
                              Edit
                            </MenuItem>
                          )}
                          {isAdmin && (
                            <MenuItem icon={<RefreshCw className="size-3.5" />} onClick={() => { close(); reingest.mutate(d.id); }}>
                              Re-ingest
                            </MenuItem>
                          )}
                          {isAdmin && (
                            <MenuItem
                              danger
                              icon={<Trash2 className="size-3.5" />}
                              onClick={async () => {
                                close();
                                if (await confirm({ title: `Delete “${d.title}”?`, message: 'The assistant will no longer use this content.', confirmLabel: 'Delete', danger: true })) remove.mutate(d.id);
                              }}
                            >
                              Delete
                            </MenuItem>
                          )}
                        </>
                      )}
                    </Popover>
                  </TD>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      <ChunksDrawer doc={chunksDoc} onClose={() => setChunksDoc(null)} />
    </Card>
  );
}

function ChunksDrawer({ doc, onClose }: { doc: KbDocument | null; onClose: () => void }) {
  const chunks = useQuery({ queryKey: ['chunks', doc?.id, doc?.updatedAt], queryFn: () => get<Chunk[]>(`/v1/documents/${doc!.id}/chunks`), enabled: Boolean(doc) });
  return (
    <Drawer open={Boolean(doc)} onClose={onClose} title={doc ? `Chunks · ${doc.title}` : 'Chunks'} description="How the document was split for search. Each chunk is retrieved on its own.">
      {chunks.isLoading ? (
        <SkeletonRows rows={5} className="p-0" />
      ) : chunks.error ? (
        <ErrorBanner error={chunks.error} />
      ) : !chunks.data?.length ? (
        <EmptyState title="No chunks" description={doc?.status === 'ready' ? 'The document had no extractable text.' : 'Chunks appear once ingestion finishes.'} />
      ) : (
        <ol className="space-y-3">
          {chunks.data.map((c) => (
            <li key={c.id} className="rounded-lg border border-border p-3">
              <p className="mb-1 flex items-center justify-between text-caption text-muted">
                <span>
                  #{c.chunkIndex + 1} · <span className="font-medium text-fg-2">{c.title}</span>
                </span>
                <span>{c.tokenCount} tokens</span>
              </p>
              <p className="text-body-sm whitespace-pre-wrap text-fg">{c.content}</p>
            </li>
          ))}
        </ol>
      )}
    </Drawer>
  );
}

function CategorySelect({ value, onChange }: { value: DocumentCategory; onChange: (v: DocumentCategory) => void }) {
  return (
    <Field label="Category" hint="Helps the assistant pick the right source.">
      <Select value={value} onChange={(e) => onChange(e.target.value as DocumentCategory)}>
        {DOCUMENT_CATEGORIES.map((c) => (
          <option key={c} value={c}>
            {categoryLabel(c)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

function DialogFooter({ onClose, form, label, loading, disabled }: { onClose: () => void; form: string; label: string; loading?: boolean; disabled?: boolean }) {
  return (
    <>
      <Button variant="ghost" onClick={onClose}>
        Cancel
      </Button>
      <Button type="submit" form={form} variant="primary" loading={loading} disabled={disabled}>
        {label}
      </Button>
    </>
  );
}

function KbDialog({ kb, onClose }: { kb?: KnowledgeBase; onClose: () => void }) {
  const languages = useKnowledgeLanguages();
  const [name, setName] = useState(kb?.name ?? '');
  const [description, setDescription] = useState(kb?.description ?? '');
  const [language, setLanguage] = useState(kb?.language ?? 'english');
  const body = { name: name.trim(), description, language };
  const save = useAction(
    () => (kb ? patch<KnowledgeBase>(`/v1/knowledge-bases/${kb.id}`, body) : post<KnowledgeBase>('/v1/knowledge-bases', body)),
    {
      invalidate: [['kbs']],
      success: kb ? 'Knowledge base updated' : 'Knowledge base created',
      onSuccess: (created) => {
        onClose();
        if (!kb) navigate(`/knowledge/${created.id}`);
      },
    },
  );
  return (
    <Modal open onClose={onClose} title={kb ? 'Edit knowledge base' : 'New knowledge base'} footer={<DialogFooter onClose={onClose} form="kb-form" label={kb ? 'Save' : 'Create'} loading={save.isPending} disabled={!name.trim()} />}>
      <form
        id="kb-form"
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Name" required>
          <Input value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description">
          <Textarea rows={2} maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field
          label="Language of the documents"
          hint={
            kb && language !== kb.language
              ? 'Saving re-reads this knowledge base for keyword search. Nothing is re-embedded, so it costs nothing.'
              : 'Keyword search matches word forms in this language, e.g. “cuesta” and “cuestan”. Mixed or other languages: Any language.'
          }
        >
          <Select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {(languages.data ?? [{ value: language, label: languageName(language, undefined) }]).map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
      </form>
    </Modal>
  );
}

function TextDocDialog({ kbId, doc, onClose }: { kbId: string; doc?: KbDocument; onClose: () => void }) {
  const [title, setTitle] = useState(doc?.title ?? '');
  const [category, setCategory] = useState<DocumentCategory>(doc?.category ?? 'general');
  const [content, setContent] = useState(doc?.content ?? '');
  const save = useAction(
    () =>
      doc
        ? patch<KbDocument>(`/v1/documents/${doc.id}`, { title: title.trim(), category, content })
        : post<KbDocument>(`/v1/knowledge-bases/${kbId}/documents`, { type: 'text', title: title.trim(), content, category }),
    { invalidate: [['documents', kbId], ['kbs']], success: doc ? 'Document updated — re-ingesting' : 'Document added — ingesting', onSuccess: onClose },
  );
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={doc ? 'Edit text' : 'Add text'}
      description="Paste policies, service descriptions, pricing — anything written. Markdown headings help split it into sections."
      footer={<DialogFooter onClose={onClose} form="text-doc" label={doc ? 'Save & re-ingest' : 'Add'} loading={save.isPending} disabled={!title.trim() || !content.trim()} />}
    >
      <form id="text-doc" className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px]">
          <Field label="Title" required>
            <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <CategorySelect value={category} onChange={setCategory} />
        </div>
        <Field label="Content" required>
          <Textarea rows={16} className="font-mono text-body-sm" value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}

function FaqDocDialog({ kbId, doc, onClose }: { kbId: string; doc?: KbDocument; onClose: () => void }) {
  const [title, setTitle] = useState(doc?.title ?? 'FAQs');
  const [category, setCategory] = useState<DocumentCategory>(doc?.category ?? 'faq');
  const [rows, setRows] = useState<FaqItem[]>(doc?.faq?.length ? doc.faq.map((f) => ({ ...f })) : [{ question: '', answer: '' }]);
  const valid = rows.filter((r) => r.question.trim() && r.answer.trim());
  const save = useAction(
    () =>
      doc
        ? patch<KbDocument>(`/v1/documents/${doc.id}`, { title: title.trim(), category, faq: valid })
        : post<KbDocument>(`/v1/knowledge-bases/${kbId}/documents`, { type: 'faq', title: title.trim() || 'FAQs', faq: valid, category }),
    { invalidate: [['documents', kbId], ['kbs']], success: doc ? 'FAQs updated — re-ingesting' : 'FAQs added — ingesting', onSuccess: onClose },
  );
  const setRow = (i: number, patchRow: Partial<FaqItem>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patchRow } : row)));
  return (
    <Modal
      open
      size="lg"
      onClose={onClose}
      title={doc ? 'Edit FAQs' : 'Add FAQs'}
      description="Each question and answer becomes its own searchable entry."
      footer={<DialogFooter onClose={onClose} form="faq-doc" label={doc ? 'Save & re-ingest' : valid.length ? `Add ${valid.length} FAQ${valid.length === 1 ? '' : 's'}` : 'Add FAQs'} loading={save.isPending} disabled={valid.length === 0} />}
    >
      <form id="faq-doc" className="space-y-4" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_200px]">
          <Field label="Title">
            <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <CategorySelect value={category} onChange={setCategory} />
        </div>
        <div className="space-y-3">
          {rows.map((r, i) => (
            <div key={i} className="flex gap-2 rounded-lg border border-border p-3">
              <div className="flex-1 space-y-2">
                <Field label={`Question ${i + 1}`}>
                  <Input value={r.question} maxLength={1000} onChange={(e) => setRow(i, { question: e.target.value })} />
                </Field>
                <Field label="Answer">
                  <Textarea rows={2} maxLength={10000} value={r.answer} onChange={(e) => setRow(i, { answer: e.target.value })} />
                </Field>
              </div>
              <IconButton label={`Remove question ${i + 1}`} size="sm" disabled={rows.length === 1} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setRows((r) => [...r, { question: '', answer: '' }])}>
            Add question
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function RefreshSelect({ value, onChange }: { value: RefreshInterval; onChange: (v: RefreshInterval) => void }) {
  return (
    <Field label="Keep up to date" hint="Re-fetch the page on a schedule. An unchanged page costs nothing; changes are re-ingested.">
      <Select value={String(value ?? 'off')} onChange={(e) => onChange(e.target.value === 'off' ? null : (Number(e.target.value) as 24 | 168))}>
        <option value="off">Off</option>
        <option value="24">Daily</option>
        <option value="168">Weekly</option>
      </Select>
    </Field>
  );
}

function UrlDocDialog({ kbId, doc, onClose }: { kbId: string; doc?: KbDocument; onClose: () => void }) {
  const [url, setUrl] = useState(doc?.sourceUri ?? '');
  const [title, setTitle] = useState(doc?.title ?? '');
  const [category, setCategory] = useState<DocumentCategory>(doc?.category ?? 'general');
  const [crawl, setCrawl] = useState(doc?.options.crawl ?? false);
  const [maxPages, setMaxPages] = useState(doc?.options.maxPages ?? 10);
  const [refresh, setRefresh] = useState<RefreshInterval>(doc?.refreshIntervalHours ?? null);
  // Only a new title makes the server fetch the page again; the category and schedule apply as they are.
  const refetch = Boolean(doc) && title.trim() !== doc?.title;
  const save = useAction(
    () =>
      doc
        ? patch<KbDocument>(`/v1/documents/${doc.id}`, {
            ...(refetch ? { title: title.trim() } : {}),
            ...(category !== doc.category ? { category } : {}),
            ...(refresh !== doc.refreshIntervalHours ? { refreshIntervalHours: refresh } : {}),
          })
        : post<KbDocument>(`/v1/knowledge-bases/${kbId}/documents`, {
            type: 'url',
            url: url.trim(),
            title: title.trim() || undefined,
            crawl,
            maxPages,
            category,
            refreshIntervalHours: refresh,
          }),
    {
      invalidate: [['documents', kbId], ['kbs']],
      success: doc ? (refetch ? 'Page updated — fetching it again' : 'Page updated') : 'Page added — fetching and ingesting',
      onSuccess: onClose,
    },
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={doc ? 'Edit web page' : 'Add a web page'}
      description="We fetch the page (and optionally follow links on the same site) and keep the text."
      footer={<DialogFooter onClose={onClose} form="url-doc" label={doc ? 'Save' : 'Add page'} loading={save.isPending} disabled={!url.trim() || (Boolean(doc) && !title.trim())} />}
    >
      <form id="url-doc" className="space-y-4" onSubmit={(e: FormEvent) => { e.preventDefault(); save.mutate(); }}>
        <Field label="URL" required={!doc} hint={doc ? 'To fetch a different address, add it as a new page.' : undefined}>
          <Input type="url" placeholder="https://example.com/pricing" value={url} disabled={Boolean(doc)} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Title" hint={doc ? undefined : 'Optional — defaults to the page address.'}>
            <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <CategorySelect value={category} onChange={setCategory} />
        </div>
        {!doc && (
          <>
            <Toggle label="Crawl linked pages" description="Also fetch pages linked from this one on the same website." checked={crawl} onChange={setCrawl} />
            {crawl && (
              <Field label="Max pages" hint="1–50">
                <NumberInput min={1} max={50} value={maxPages} onChange={(v) => setMaxPages(Math.min(50, Math.max(1, Math.round(v ?? 10))))} />
              </Field>
            )}
          </>
        )}
        <RefreshSelect value={refresh} onChange={setRefresh} />
      </form>
    </Modal>
  );
}

function UploadDialog({ kbId, onClose }: { kbId: string; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState<DocumentCategory>('general');
  const upload = useAction(
    () => {
      const form = new FormData();
      form.append('file', file!);
      return api<KbDocument>(`/v1/knowledge-bases/${kbId}/upload`, { method: 'POST', formData: form, query: { title: title.trim(), category } });
    },
    { invalidate: [['documents', kbId], ['kbs']], success: 'File uploaded — extracting text', onSuccess: onClose },
  );
  return (
    <Modal open onClose={onClose} title="Upload a file" description="PDF, DOCX, TXT, Markdown, CSV or HTML." footer={<DialogFooter onClose={onClose} form="upload-doc" label="Upload" loading={upload.isPending} disabled={!file} />}>
      <form id="upload-doc" className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (file) upload.mutate(); }}>
        <Field label="File" required hint={file ? `${file.name} · ${formatBytes(file.size)}` : undefined}>
          <input
            type="file"
            accept=".pdf,.docx,.txt,.md,.markdown,.csv,.html,.htm,application/pdf,text/plain,text/markdown,text/csv,text/html,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="block w-full text-body-sm text-fg-2 file:mr-3 file:rounded-md file:border file:border-border-strong file:bg-surface file:px-3 file:py-1.5 file:text-body-sm file:font-medium file:text-fg hover:file:bg-surface-2"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Title" hint="Optional — defaults to the file name.">
            <Input value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />
          </Field>
          <CategorySelect value={category} onChange={setCategory} />
        </div>
      </form>
    </Modal>
  );
}

function RetrievalTester({ kbs, currentKbId }: { kbs: KnowledgeBase[]; currentKbId: string }) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string[]>([currentKbId]);
  const [limit, setLimit] = useState(5);
  useEffect(() => setSelected((s) => (s.includes(currentKbId) ? s : [currentKbId])), [currentKbId]);
  const search = useAction((vars: { query: string; knowledgeBaseIds: string[]; limit: number }) => post<SearchResult>('/v1/knowledge/search', vars), { errorToast: false });
  const result = search.data;
  const groundingTone = result?.grounding === 'grounded' ? 'green' : result?.grounding === 'weak' ? 'amber' : 'red';
  return (
    <Card>
      <CardHeader title="Test retrieval" description="Ask a question the way a visitor would and see exactly which passages the assistant would get." />
      <form
        className="space-y-3 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (query.trim() && selected.length) search.mutate({ query: query.trim(), knowledgeBaseIds: selected, limit });
        }}
      >
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden />
            <Input aria-label="Test question" className="pl-8" placeholder="e.g. Do you take my insurance?" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <Select aria-label="Number of results" className="w-28" value={String(limit)} onChange={(e) => setLimit(Number(e.target.value))}>
            {[3, 5, 8, 10, 20].map((n) => (
              <option key={n} value={n}>
                Top {n}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="primary" loading={search.isPending} disabled={!query.trim() || !selected.length}>
            Search
          </Button>
        </div>
        {kbs.length > 1 && (
          <fieldset className="flex flex-wrap gap-4">
            <legend className="sr-only">Knowledge bases to search</legend>
            {kbs.map((k) => (
              <Checkbox key={k.id} label={k.name} checked={selected.includes(k.id)} onChange={(e) => setSelected((s) => (e.target.checked ? [...s, k.id] : s.filter((id) => id !== k.id)))} />
            ))}
          </fieldset>
        )}
      </form>
      {result && (
        <div className="border-t border-border p-4">
          <p className="mb-3 flex items-center gap-2 text-body-sm text-fg-2">
            Grounding: <Badge tone={groundingTone}>{result.grounding}</Badge>
            <span className="text-caption text-muted">
              {result.grounding === 'grounded'
                ? 'Clearly relevant material found — the assistant will answer from it.'
                : result.grounding === 'weak'
                  ? 'Only loosely related material — the assistant will be cautious.'
                  : 'Nothing relevant — the assistant follows your “unknown answer” guardrail.'}
            </span>
          </p>
          {result.chunks.length === 0 ? (
            <p className="text-body-sm text-muted">No passages found.</p>
          ) : (
            <ol className="space-y-2">
              {result.chunks.map((c, i) => (
                <li key={c.id} className="rounded-xl border border-border bg-surface p-3.5">
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-caption">
                    <span className="font-medium text-fg">
                      {i + 1}. {c.title}
                      {c.url && (
                        <a href={c.url} target="_blank" rel="noreferrer" className="ml-2 font-normal text-accent-text hover:underline">
                          source
                        </a>
                      )}
                    </span>
                    <span className="flex gap-2 text-muted tabular-nums">
                      {typeof c.similarity === 'number' && (
                        <span className="flex items-center gap-1.5">
                          <span className="h-1 w-12 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                            <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, c.similarity * 100))}%` }} />
                          </span>
                          similarity {(c.similarity * 100).toFixed(1)}%
                        </span>
                      )}
                      <span>score {c.score.toFixed(4)}</span>
                    </span>
                  </div>
                  <p className="line-clamp-4 text-body-sm whitespace-pre-wrap text-fg-2">{c.content}</p>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      {search.error ? <ErrorBanner error={search.error} className="mx-4 mb-4" /> : null}
    </Card>
  );
}
