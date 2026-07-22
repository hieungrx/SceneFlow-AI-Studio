# CONVENTIONS.md — SceneFlow AI Studio

> Quy ước code cụ thể cho codebase SceneFlow. File này bổ sung cho `AGENTS.md` — đọc `AGENTS.md` trước để hiểu bối cảnh, ranh giới, và luồng nghiệp vụ.

---

## 1. TypeScript & Naming

### Naming

| Đối tượng | Convention | Ví dụ |
|---|---|---|
| File business/utility | kebab-case | `veo-provider.ts`, `render-plan.ts`, `mock-store.ts` |
| React component file | PascalCase | `StudioDashboard.tsx`, `SceneList.tsx` |
| Type / Interface | PascalCase | `Scene`, `VideoProvider`, `RenderManifest` |
| Function / Variable | camelCase | `buildRenderManifest`, `compileScenePrompt` |
| DB column (Drizzle) | snake_case | `scene_index`, `created_at`, `story_bible_json` |
| API error code | snake_case string | `"authentication_required"`, `"invalid_project_payload"` |
| CSS class | kebab-case | Ưu tiên khai báo trong `globals.css`; xem ngoại lệ runtime ở mục 6 |

### ID Generation

Mọi entity dùng prefix + `crypto.randomUUID()`:

```typescript
`prj_${crypto.randomUUID()}`      // Project
`scene_${crypto.randomUUID()}`    // Scene
`job_${crypto.randomUUID()}`      // GenerationJob
`asset_${crypto.randomUUID()}`    // AssetRecord
`render_${crypto.randomUUID()}`   // FinalRender
`credit_welcome_${crypto.randomUUID()}`  // Welcome credit
`credit_job_${jobId}`                    // Generation debit, idempotent theo job
```

Không dùng auto-increment integer, không dùng UUID thô không có prefix. Credit ledger là ngoại lệ có chủ đích đối với mẫu `prefix + randomUUID()`: debit dùng `jobId` để retry không thể tạo nhiều charge cho cùng một job. Các `kind` hiện có là `welcome_grant` và `generation_debit`; thêm kind mới phải ghi rõ chiến lược idempotency.

### Type Definitions

- Tất cả shared types nằm trong `lib/types.ts`
- Planning dùng `SceneContract` provider-neutral và serializable; không đưa GCS/R2 URI hoặc provider payload shape vào contract ở 2.5A
- Dùng union literal cho status: `"draft" | "planning" | "generating" | ...`
- Dùng `as const` cho static readonly arrays/tuples
- Ưu tiên `Pick<>`, `Omit<>`, `Partial<>` thay vì duplicate type shape
- Không dùng `any` — dùng `unknown` + type guard nếu cần
- Import alias `@/*` được ưu tiên cho import xuyên layer từ project root. Relative import ngắn trong cùng thư mục/layer vẫn được phép; không tạo chuỗi `../../../` mới nếu alias làm đường dẫn rõ hơn.

---

## 2. Database & Drizzle ORM

### Schema (`db/schema.ts`)

- Mọi table dùng `sqliteTable` (Cloudflare D1)
- Primary key: `text("id")` — không dùng auto-increment
- Timestamp: `text("created_at")` / `text("updated_at")` — lưu ISO 8601 string
- JSON data: lưu dạng text column với suffix `_json` (ví dụ: `story_bible_json`, `manifest_json`, `assumptions_json`)

### Data Access (`lib/repository.ts`)

- **Repository là cổng duy nhất cho business query** — không viết query Drizzle trong UI, API route hoặc business module khác. `db/index.ts`, `db/schema.ts` và `db/bootstrap.ts` là ngoại lệ hạ tầng.
- Mọi function ghi dữ liệu **bắt buộc** nhận `ownerId` và kiểm tra ownership
- Bọc mọi operation trong `withMemoryFallback()`:

```typescript
// Pattern chuẩn — không bỏ qua fallback
return withMemoryFallback(
  async (db) => { /* Drizzle query */ },
  () => { /* In-memory fallback */ },
);
```

- Parse JSON trong `*FromRow()` converter, không trong query:

```typescript
// ✅ Đúng
function projectFromRow(row): Project {
  return { ...row, storyBible: parseStoryBible(row.storyBibleJson) };
}

// ❌ Sai — không parse trong select query
db.select({ bible: sql`json(story_bible_json)` })
```

### Planning versioning

- `storyboards.compiled_json` là nguồn authoritative cho Story Bible snapshot và Scene Contracts của từng version.
- `prompt_versions.assumptions_json` giữ metadata mở rộng (`assumptions`, `compilerVersion`, `generationMode`, `lintIssues`) qua converter; không parse JSON trong route.
- `scenes` là active projection, bắt buộc gắn `storyboard_id` cho planning version mới. Không coi scene rows là lịch sử authoritative.
- Replan tạo storyboard/scene IDs mới và giữ storyboard/prompt rows cũ. Không xóa projection nếu project đã có job/render history vì operation schema hiện chưa có immutable version binding.
- Thay active projection và ghi version/prompt/project status phải dùng D1 batch atomic theo pattern hiện có.

### Migration

- Generate: `npm run db:generate` (drizzle-kit)
- File migration trong `drizzle/` với đánh số tuần tự
- Bootstrap idempotent trong `db/bootstrap.ts` — tự chạy `CREATE TABLE IF NOT EXISTS` ở request đầu tiên

---

## 3. API Routes

### Authentication Pattern

Mọi route đọc dữ liệu thuộc owner hoặc thay đổi persistent state phải bắt đầu bằng auth check:

```typescript
export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  // ... logic
}
```

- Không bao giờ tin `ownerId` từ client — luôn derive từ `user.email`
- Endpoint stateless/public có thể skip auth khi không đọc dữ liệu owner và không thay đổi persistent state. Hiện `POST /api/prompts/optimize` là endpoint public theo mô hình này.

### Request Validation

```typescript
// Safe JSON parse — không throw khi body malformed
const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;

// Validate trước business logic
if (!body || !isNonEmptyText(body.name, 120)) {
  return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
}

// Clamp/normalize inputs
function clampDuration(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 30;
  return Math.max(8, Math.min(300, Math.round(value)));
}
```

### Response Format

- Wrap data trong named key — không trả raw object/array:

```typescript
// ✅ Đúng
return NextResponse.json({ project }, { status: 201 });
return NextResponse.json({ scenes });
return NextResponse.json({ job, continuityReady });

// ❌ Sai
return NextResponse.json(project);
return NextResponse.json(scenes);
```

- HTTP status: `201` cho created, `200` cho read/update, `400`/`401`/`402`/`404` cho errors
- Error format: `{ error: "snake_case_error_code" }` — không gửi raw error message cho client

---

## 4. Video Provider

### Interface Contract

```typescript
export interface VideoProvider {
  readonly name: "mock" | "google";
  submit(request: SubmitVideoRequest): Promise<ProviderOperation>;
  poll(operationId: string): Promise<ProviderOperation>;
  cancel(operationId: string): Promise<void>;
}
```

- Không thêm logic provider-specific bên ngoài class implementations
- Selection qua factory: `createVideoProvider()` đọc `VEO_PROVIDER` env var
- Mock là default — không tốn tiền khi dev

### Prompt Compilation

- Brief preview đi qua `compileBriefPreview()` và phải hiển thị đúng đây là deterministic rules, không phải AI/LLM planner.
- Scene prompt đi qua `compileScenePrompt()` từ authoritative `SceneContract`.
- Compiler phải dispatch rõ theo `text_to_video`, `first_frame`, `first_last_frame`, `reference_guided` và trả `compilerVersion` ổn định.
- Text-to-video phải chứa concrete Story Bible truth. Image-guided modes tập trung vào motion/boundary và không lặp lại toàn bộ static state.
- Negative constraint nằm provider-neutral trong contract; formatter tạo chuỗi theo target provider.
- Prompt lint error chặn compile; warning được persist cùng prompt version. Không bỏ qua camera conflict, multiple primary action, stable-end hoặc continuity-lock checks.
- Cùng contract, compiler version và target provider phải cho output deterministic.

---

## 5. Security

### Secrets

- Mọi secret qua environment variables, không bao giờ hardcode
- `.env.local` gitignored — dùng `.env.example` làm template
- GCS URI validate bằng regex trước khi gọi API:

```typescript
/^gs:\/\/[a-z0-9][a-z0-9._-]{1,221}[a-z0-9](?:\/.*)?$/i
```

### File Upload

- Chỉ chấp nhận: `image/jpeg`, `image/png`, `image/webp`
- Kích thước tối đa: 20MB
- Multipart request bị giới hạn trước khi parse đầy đủ; không chỉ dựa vào `File.size` sau `formData()`
- MIME khai báo phải khớp magic bytes/container signature được phát hiện; filename không quyết định MIME hoặc extension lưu trữ
- R2 object key: random UUID — **không bao giờ** dùng filename người dùng làm key
- Nếu R2 put thành công nhưng ghi asset metadata thất bại, chỉ được compensating delete đúng object key vừa tạo; không xóa theo prefix
- Magic-byte validation không thay thế full image decode/re-encode; nếu cần chống polyglot hoặc decompression bomb sâu hơn phải có thiết kế riêng được duyệt

### Auth & Ownership

- Mọi resource (project, scene, job, asset, render) thuộc về một owner
- Kiểm tra ownership **phía server** ở mọi read/write operation
- Return path validation qua `safeRelativeReturnPath()` — chống open redirect:

```typescript
// Reject: "//evil.com", paths outside app, reserved auth paths
if (!value.startsWith("/") || value.startsWith("//")) return "/";
```

### Credit Ledger

- **Append-only** — không bao giờ UPDATE entry cũ
- Kiểm tra `balance >= amount` trước khi gửi generation job
- Balance tính bằng `balanceAfter` của entry gần nhất (không SUM)

---

## 6. Components & UI

### General Rules

- Client components: đánh dấu `"use client"` ở đầu file
- Giữ mỗi component **dưới 300 dòng** — tách sub-component khi vượt
- Không prop-drill quá 2 cấp — tách context hoặc component composition
- Text UI bằng tiếng Việt (`lang="vi"` trong root layout)
- `useMemo` cho computed values tốn chi phí, không memoize mọi thứ

### CSS Approach

- Design system custom trong `app/globals.css` (CSS custom properties)
- Tailwind CSS 4 đã cài nhưng hiện tại UI dùng **hand-written CSS** — giữ nhất quán:
  - Feature mới trong component hiện có → follow style CSS hiện tại
  - Component mới hoàn toàn → có thể dùng Tailwind utilities nếu phù hợp, nhưng hỏi trước
- Không dùng inline style cho styling tĩnh
- Inline style được phép cho giá trị runtime khó biểu diễn bằng class tĩnh, ví dụ `width` của progress bar; giá trị phải được clamp/validate trước khi đưa vào style

### StudioDashboard (known debt)

`StudioDashboard.tsx` hiện 626 dòng tại baseline Checkpoint 2.3 — đây là tech debt đã biết. Khi refactor (phải hỏi trước), tách thành:
- `StudioSidebar` — navigation
- `ProjectForm` — tạo/sửa project
- `SceneList` — danh sách cảnh với status
- `JobQueue` — theo dõi generation jobs
- `RenderPanel` — render controls + preview
- `PromptOptimizer` — prompt compilation UI

---

## 7. Testing

### Framework & Commands

- Node.js built-in test runner (`node --test`)
- File test: `tests/*.test.mjs`
- Chạy test: `npm test` (build trước, rồi test)
- Chạy full verify: `npm run verify` (lint + test + renderer syntax check)

### Expectations

- Mọi module `lib/` mới phải có test tương ứng
- API route mới: test auth + validation + happy path
- Test function mới không phá test cũ — chạy `npm run verify` trước khi báo xong
- Renderer service (`services/renderer/server.mjs`) phải pass `node --check`

---

## 8. Build & Deploy

### Scripts

```bash
npm run dev          # Vinext dev (Vite + local Cloudflare Workers emulation)
npm run build        # Production build → dist/
npm run start        # Wrangler dev chạy từ dist/ (port 3000)
```

Hiện `package.json` chưa có script deploy. Không ghi hoặc chạy `npm run deploy:worker` cho đến khi quy trình deploy được định nghĩa và script thật được thêm vào.

### Cloudflare Workers

- Entry: `worker/index.ts`
- Data bindings trong `.openai/hosting.json`: `DB` (D1), `MEDIA` (R2)
- Worker runtime còn sử dụng `ASSETS` cho static assets và `IMAGES` cho image optimization; đây không phải hai data binding được khai báo trong `.openai/hosting.json`
- Compatibility flag: `nodejs_compat`
- Local state: `.wrangler/state` (gitignored, tách khỏi `dist/`)
- **Không truy cập bindings từ client-side code** — `import { env } from "cloudflare:workers"` chỉ dùng trong server code

### Renderer Service

- Thư mục: `services/renderer/`
- Zero npm dependencies — pure Node.js
- Giao tiếp: HTTP POST + `x-renderer-token` header
- Deploy: Docker → Cloud Run
- Contract API: xem `services/renderer/README.md`
