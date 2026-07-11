# AGENTS.md — SceneFlow AI Studio

> File này là nguồn thông tin đầu vào bắt buộc cho AI coding agent (Cursor, Windsurf, Claude Code, Antigravity, hoặc tương đương) khi làm việc trên repo SceneFlow. Đọc toàn bộ file này TRƯỚC KHI đọc hoặc sửa bất kỳ file code nào trong project.

## 1. Vai trò của agent trong dự án này

Agent đóng vai trò kỹ sư hỗ trợ triển khai, **không phải người quyết định kiến trúc cuối cùng**. Mọi thay đổi có ảnh hưởng rộng (schema, contract API, provider pattern, cơ chế continuity) cần được con người xác nhận **trước khi viết code**, không chỉ trước khi merge.

## 2. Snapshot dự án

SceneFlow AI Studio là xưởng sản xuất video AI, biến một brief thành video hoàn chỉnh qua pipeline:

**Brief → Story Bible → Storyboard → Tạo từng cảnh → QC → Ghép video**

Ràng buộc nghiệp vụ cốt lõi — nhớ trong MỌI task, đây là lý do hệ thống tồn tại:
- Nhân vật, sản phẩm, bối cảnh phải nhất quán giữa các cảnh
- Mỗi cảnh dài 4, 6 hoặc 8 giây
- Cảnh sau **chỉ** được tạo khi cảnh trước vượt QC — không có ngoại lệ
- Frame cuối của cảnh trước là điểm neo continuity cho cảnh kế tiếp
- Output cuối là video 1080p đã ghép hoàn chỉnh

| Layer | Công nghệ |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript 5.9, Tailwind CSS 4 |
| Runtime/build | Vinext 0.0.50 + Vite 8, deploy dạng Cloudflare Workers |
| Database | Cloudflare D1 qua Drizzle ORM 0.45.2 |
| Media storage | Cloudflare R2 |
| Video generation | Adapter pattern — mock và Google Vertex AI Veo 3.1 |
| Rendering | Dịch vụ FFmpeg độc lập (zero-dependency Node.js), Dockerfile → Cloud Run |
| Auth | Sign in with ChatGPT (header-based: `oai-authenticated-user-email`) |
| CI | GitHub Actions — lint, build, test trên Node.js 22 |
| Module system | ESM (`"type": "module"`) |

## 3. Lệnh thường dùng

*Đã xác nhận khớp `package.json` tại thời điểm viết — nếu script thay đổi, cập nhật mục này ngay.*

```bash
npm run dev           # Vinext dev server (Vite + Cloudflare Workers local)
npm run build         # Production build (vinext build)
npm run start         # Wrangler dev với output build (port 3000)
npm run lint          # ESLint (bỏ qua dist/, .next/)
npm test              # Build trước → chạy node --test tests/rendered-html.test.mjs
npm run verify        # lint + test + node --check services/renderer/server.mjs
npm run db:generate   # Drizzle-kit generate migration
```

> **Lưu ý Windows**: `dev`, `build`, `start` dùng `cross-env` để đặt biến môi trường. Dừng server (`Ctrl+C`) trước khi build lại để tránh `EBUSY`.

## 4. Thứ tự đọc bắt buộc (không nhảy cóc)

1. File này (`AGENTS.md`)
2. `CONVENTIONS.md` (ở repository root, cùng thư mục với file này) — quy ước code cụ thể
3. `ARCHITECTURE.md` — nếu chưa tồn tại, dùng mục 5 dưới đây
4. `DECISIONS.md` — nếu chưa tồn tại, xem mục 9 để biết các đánh đổi đã chọn
5. Cây thư mục thật — đối chiếu với mục 5, báo lệch nếu phát hiện

Sau khi đọc xong:
- Với task ảnh hưởng kiến trúc, schema, API contract, provider, auth, ownership, credit hoặc continuity: tóm tắt lại 5–7 câu và chờ con người xác nhận trước khi sửa code.
- Với thay đổi cục bộ, ít rủi ro và không đổi hành vi/contract: có thể thực hiện trực tiếp theo conventions, không cần tạo một vòng xác nhận hình thức.

## 5. Bản đồ codebase

| Thư mục | Trách nhiệm | Conventions tóm tắt |
|---|---|---|
| `app/` | Giao diện Studio và API routes | Server Components mặc định; `"use client"` khi cần hooks/state |
| `app/api/` | REST API route handlers | Auth check đầu tiên; response wrap `{ key }` ; safe JSON parse |
| `app/components/` | Client components | Tách < 300 dòng/file; Vietnamese UI text |
| `lib/` | Business logic, providers, repository | Server-safe; không import `cloudflare:workers` trong client code |
| `db/`, `drizzle/` | Schema Drizzle ORM và migration D1 | JSON column suffix `_json`; parse qua `*FromRow()` |
| `services/renderer/` | Dịch vụ ghép video FFmpeg (Cloud Run) | Zero-dependency Node.js; giao tiếp qua HTTP + token |
| `tests/` | Test build HTML và pipeline mock | Node.js test runner; file `.test.mjs` |
| `worker/` | Điểm vào Cloudflare Worker | Data bindings: `DB` (D1), `MEDIA` (R2); runtime còn dùng `ASSETS`, `IMAGES` |

Chi tiết conventions cho từng layer → xem `CONVENTIONS.md`.

**Ranh giới cần giữ nguyên khi sửa code**:
- Video provider (`lib/veo-provider.ts`) và renderer (`services/renderer/`, `lib/renderer-client.ts`) **độc lập** với giao diện/API chính — đây là lý do hệ thống chuyển được từ mock sang Veo thật mà không phải đổi UI hay route
- Repository layer (`lib/repository.ts`) là cổng duy nhất truy cập DB — không viết query Drizzle ngoài file này
- **Không phá vỡ các ranh giới trên khi thêm feature mới**, dù có vẻ "tiện" hơn nếu gộp lại

## 6. Luồng nghiệp vụ (tham chiếu khi debug hoặc thêm feature)

1. Người dùng đăng nhập (ChatGPT auth headers) → `ensureUser()` tạo/cập nhật user + welcome credit
2. Tạo project → gán Story Bible mặc định
3. Brief được tối ưu thành prompt có cấu trúc qua `compileVideoPrompt()` — tách intent, assumptions, negative prompt
4. Hệ thống tạo storyboard 4 cảnh với dependency chain (`dependsOnSceneId`)
5. Các cảnh vào hàng đợi theo thứ tự phụ thuộc — kiểm tra credit trước khi gửi
6. Veo provider (`MockVeoProvider` hoặc `GoogleVeoProvider`) tạo video cho từng cảnh
7. QC cảnh → lấy frame cuối để nối continuity (`extractLastFrame()`)
8. Nếu re-generate cảnh N → `invalidateOwnedDownstreamScenes()` reset tất cả cảnh sau N
9. Khi tất cả cảnh `approved` → `buildRenderManifest()` tạo manifest
10. FFmpeg renderer ghép cảnh (mock trả MP4 tĩnh; production dùng Cloud Run)
11. Người dùng xem video qua API hỗ trợ stream + HTTP Range

## 7. Trạng thái hiện tại

**Đã hoàn thành (MVP):** Studio UI · quản lý project · prompt compiler · Story Bible + storyboard 4 cảnh · pipeline tạo cảnh tuần tự · mock QC + khóa frame nối cảnh · D1/R2 + kiểm tra quyền sở hữu dữ liệu · credit ledger append-only · mock Veo + adapter Vertex AI Veo thật · MP4 mẫu phát được · renderer FFmpeg + API contract cho Cloud Run · API tương đối đầy đủ cho pipeline · CI cơ bản. Lint, production build, 3 test và kiểm tra renderer đều PASS tại thời điểm viết file này.

**Còn thiếu trước production — không coi các mục này là "đã ổn":**
- Triển khai renderer FFmpeg lên Cloud Run thật
- Cấu hình Google Cloud, GCS, quyền service account
- Test end-to-end với Veo thật (hiện chỉ có mock)
- Hàng đợi production: rate limit, retry, dead-letter queue
- Theo dõi chi phí, log, metric, cảnh báo
- Chính sách hết hạn/xóa media
- Test sâu hơn: database, authorization, lỗi provider, concurrency
- QC thực tế — phần hiện tại chủ yếu là nền tảng/mô phỏng
- Quota Veo đủ cho ~100 video/ngày nếu đó là mục tiêu
- Error boundaries và error handling UI phía client
- Tách `StudioDashboard.tsx` (540 dòng) thành nhiều component nhỏ hơn
- Xác thực magic bytes/file signature cho ảnh upload; hiện MVP mới kiểm tra MIME metadata từ `File.type`

**⚠️ Quy tắc kiểm tra trạng thái Git — đọc trước khi chạy bất kỳ lệnh git nào:**
- Luôn kiểm tra `git status --short` và `git log -1 --oneline` trước thao tác Git; không giả định snapshot trong tài liệu vẫn còn đúng.
- Tại lần cập nhật tài liệu ngày 2026-07-11, repo chưa có commit đầu tiên và toàn bộ code chưa được theo dõi.
- KHÔNG tự ý chạy `git init`, `git commit`, `git push`, tạo branch, rebase hoặc thao tác phá hủy lịch sử khi chưa được người dùng xác nhận.
- Nếu repo vẫn chưa có commit mà task yêu cầu sửa code, đề xuất tạo baseline commit trước; chỉ thực hiện commit khi người dùng cho phép.

## 8. Ranh giới quyết định

**Agent tự quyết** (không cần hỏi):
- Naming, format code, style viết test cho logic đã rõ ràng
- Sửa lỗi lint/type nhỏ không đổi hành vi
- Thêm test mới cho logic hiện có
- Tối ưu hiệu năng cục bộ không đổi interface
- Tuân theo conventions trong `CONVENTIONS.md`

**Phải hỏi trước khi làm:**
- Đổi schema D1 / migration Drizzle
- Đổi contract API giữa Studio UI ↔ renderer, hoặc giữa hệ thống ↔ Veo adapter
- Đổi cách adapter Veo hoạt động (logic switch mock ↔ real)
- Thay đổi ảnh hưởng đến cơ chế continuity (frame-anchor logic, dependency chain)
- Đổi cơ chế auth hoặc ownership checking pattern
- Đổi credit ledger logic (append-only constraint)
- Đổi cách lưu/đọc file trên R2 (random key pattern, content-type restrictions)
- Thêm dependency mới vào `package.json`
- Bất kỳ lệnh git init/commit/push (xem mục 7)

Nếu phát hiện mâu thuẫn giữa tài liệu và code thật → dừng lại, hỏi ngay, không tự chọn bên nào đúng.

## 9. Nguyên tắc khi đề xuất giải pháp

- Luôn nêu đánh đổi (trade-off), không chỉ lợi ích
- Không đề xuất lại giải pháp đã bị loại (ví dụ: đổi D1 sang Postgres thường) trừ khi có thông tin mới thực sự thay đổi bối cảnh — nếu vậy phải nêu rõ vì sao bối cảnh đã đổi
- Task ảnh hưởng > 1 module (ví dụ: continuity giữa scene generator và renderer) → trình bày luồng/sơ đồ trước, không code trực tiếp
- Khi đề xuất code mới, tuân thủ conventions trong `CONVENTIONS.md` — không tự tạo convention riêng

## 10. Nguyên tắc thực thi

- Chỉ làm trong phạm vi task/sprint hiện tại, không tự refactor phần ngoài scope
- Sau mỗi thay đổi kiến trúc quan trọng, đề xuất cập nhật lại mục 5 hoặc mục 9 nếu có quyết định mới phát sinh
- Trước khi báo "xong", chạy `npm run verify`; chỉ chạy thêm `dev`, `start` hoặc `db:generate` khi task thực sự cần
- Khi sửa code, giữ nguyên comments/docstrings không liên quan đến thay đổi

## 11. Định nghĩa "hoàn thành" cho một task

1. Code build + lint sạch (`npm run verify`)
2. Test liên quan pass (thêm test mới nếu logic mới chưa có test)
3. Không phá vỡ ranh giới provider/renderer/repository đã nêu ở mục 5
4. Tuân thủ conventions trong `CONVENTIONS.md` (naming, patterns, security)
5. Không tự ý xử lý git ngoài phạm vi đã xác nhận
6. Đề xuất cập nhật tài liệu liên quan nếu có thay đổi kiến trúc

## 12. Việc nên làm tiếp để hoàn thiện tài liệu

SceneFlow hiện có AGENTS.md + CONVENTIONS.md. Nên tách dần thêm:

- `ARCHITECTURE.md` — từ mục 2, 5 (diagram, data flow, component interactions)
- `BUSINESS_RULES.md` — từ mục 2 (ràng buộc nghiệp vụ) + mục 6
- `DECISIONS.md` — lý do chọn D1 thay Postgres, lý do adapter pattern cho Veo, lý do FFmpeg tách service độc lập — **hiện chưa có, cần viết mới**
- `SPRINT.md` — task đang làm, tách khỏi mục 7
- `DATABASE.md` — schema D1 chi tiết, migration strategy — **hiện chưa có, cần viết mới**

Khi đó, file AGENTS.md này sẽ ngắn lại, chỉ giữ mục 1, 3, 4, 8, 9, 10, 11 — các mục còn lại trỏ sang file chuyên biệt tương ứng.
