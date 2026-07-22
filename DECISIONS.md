# DECISIONS.md — Nhật ký quyết định SceneFlow AI Studio

> File này ghi các quyết định kiến trúc đã được con người xác nhận. Trạng thái **Accepted** xác nhận hướng thiết kế; không tự động có nghĩa là implementation và test đã hoàn tất.

## ADR-001 — Sites dispatcher sở hữu SIWC

- **Trạng thái:** Accepted
- **Ngày xác nhận:** 2026-07-18
- **Phạm vi:** Checkpoint 2.4A — auth trust boundary

### Bối cảnh

Ứng dụng hiện đọc danh tính từ header do môi trường hosting chuyển vào và dùng danh tính đó làm owner key. Ownership check trong API/repository chỉ an toàn khi origin có thể chứng minh request đã đi qua lớp xác thực đáng tin. Tự nhận header từ một origin public sẽ cho phép giả mạo danh tính.

### Quyết định

- Sites dispatcher là public ingress và sở hữu managed SIWC.
- Deployment dùng `access_mode=custom`.
- Dispatcher chịu trách nhiệm xử lý sign-in/access, loại bỏ hoặc ghi đè header danh tính từ request bên ngoài và chỉ chuyển danh tính đã xác thực đến origin.
- SceneFlow không triển khai auth flow song song và không nhận owner từ client payload.
- Origin phải nằm sau dispatcher; direct-origin bypass được xem là deployment blocker.
- `app/chatgpt-auth.ts` là consumer của identity assertion, không phải thành phần chứng minh provenance của assertion đó.

### Hệ quả và đánh đổi

- Giảm code auth và tránh hai nguồn session/identity khác nhau.
- Security phụ thuộc vào cấu hình Sites và việc origin không bị lộ trực tiếp.
- Local/integration test có thể dựng identity header trong môi trường kiểm soát, nhưng production không được dùng cách đó như bằng chứng xác thực.
- Runbook triển khai phải kiểm tra access mode và direct-origin reachability trước khi phát hành.

### Không chọn

- Tự xây một SIWC/OAuth verifier thứ hai trong ứng dụng.
- Tin identity header trên một Worker origin có thể truy cập trực tiếp.

## ADR-002 — Final-render media dùng strict Range/MIME contract

- **Trạng thái:** Accepted
- **Ngày xác nhận:** 2026-07-18
- **Phạm vi:** Checkpoint 2.4A — private final-render delivery

### Bối cảnh

Scene media đã kiểm tra một byte range, status/MIME/header upstream và không lộ body lỗi. Final-render route tại baseline mới proxy Range và một số header cơ bản, nên hai loại private video có policy khác nhau.

### Quyết định

Final-render media phải dùng cùng nguyên tắc với scene media:

- Auth và ownership chạy trước khi phân tích Range.
- Mock redirect và media-readiness check giữ nguyên trước khi gọi GCS.
- Chỉ chấp nhận request không có Range hoặc đúng một byte range hợp lệ; malformed hoặc multi-range trả local `416` và không gọi upstream.
- Request có Range chỉ chấp nhận upstream `206`; request không Range chỉ chấp nhận `200`.
- Upstream `416` chỉ được chuyển thành `416` khi `Content-Range` hợp lệ và chứng minh request không thỏa mãn.
- Media type phải là `video/mp4`; `Content-Range` phải nhất quán với request/response, còn `Content-Length`, nếu upstream cung cấp, phải hợp lệ và khớp khoảng byte.
- Response thành công dùng header private, inline, byte ranges và `nosniff` đã được allowlist.
- Mọi sai lệch protocol, MIME hoặc upstream được thu gọn thành lỗi `502`; không chuyển tiếp body lỗi hoặc thông tin nội bộ.

### Hệ quả và đánh đổi

- Hai route video private có cùng trust model và test matrix, giảm drift bảo mật.
- Contract cố ý không hỗ trợ multi-range; client phải dùng một range mỗi request.
- Một upstream response có thể phát được nhưng không khớp contract sẽ bị từ chối để ưu tiên an toàn và tính dự đoán.

### Không chọn

- Chuyển tiếp trực tiếp status/header/body của GCS.
- Giữ policy final render lỏng hơn scene media.

## ADR-003 — Upload 20 MiB, magic bytes, bounded request và exact-key compensation

- **Trạng thái:** Accepted
- **Ngày xác nhận:** 2026-07-18
- **Phạm vi:** Checkpoint 2.4A — asset ingestion

### Bối cảnh

Baseline giới hạn `File.size` ở 20 MiB và allowlist MIME, nhưng metadata MIME có thể bị giả mạo. Multipart body cũng được parse trước khi kiểm tra file, và flow R2-first có thể để lại object mồ côi nếu tạo database record thất bại.

### Quyết định

- Giữ giới hạn tối đa **20 MiB cho một file**.
- Áp một request-level bound hữu hạn trước hoặc trong quá trình nhận multipart. Bound phải tính được overhead multipart và phải có test ở ngay dưới, đúng và trên giới hạn; con số triển khai không được âm thầm làm giảm giới hạn file 20 MiB.
- Chỉ nhận JPG, PNG và WebP khi magic bytes hợp lệ.
- Media type khai báo phải khớp loại file phát hiện từ bytes; filename không quyết định loại file hoặc object key.
- Tiếp tục dùng object key ngẫu nhiên thuộc project.
- Nếu R2 put đã thành công nhưng repository không tạo được asset record, route phải thử compensating delete **đúng object key vừa put**.
- Compensation không được list bucket, không dùng prefix và không xóa object khác. Lỗi cleanup phải quan sát được nhưng không được biến thành một thao tác xóa rộng hơn.

### Hệ quả và đánh đổi

- Giảm nguy cơ file giả dạng và giảm memory/request abuse so với chỉ kiểm tra sau `formData()`.
- Giữ flow R2-first nhưng thêm failure compensation, tránh cần distributed transaction giữa D1 và R2.
- Exact-key delete an toàn hơn cleanup theo prefix, đổi lại vẫn cần observability cho trường hợp delete bù thất bại.
- Cần test malformed multipart, MIME/signature mismatch, boundary sizes và repository failure sau R2 put.

### Không chọn

- Tin `File.type`, `Content-Type` hoặc phần mở rộng filename như bằng chứng duy nhất.
- Xóa theo project prefix khi một request thất bại.
- Thêm distributed transaction giả giữa D1 và R2.

## ADR-004 — Hoãn cumulative upload quota

- **Trạng thái:** Accepted
- **Ngày xác nhận:** 2026-07-18
- **Phạm vi:** Checkpoint 2.4A — giới hạn scope

### Bối cảnh

Quota cộng dồn theo user/project cần policy sản phẩm, cách tính usage, lifecycle media, concurrency semantics và có thể cần thay đổi schema. Các quyết định đó rộng hơn mục tiêu trust-boundary hardening của 2.4A.

### Quyết định

- Không thêm cumulative upload quota trong Checkpoint 2.4A.
- 2.4A chỉ áp giới hạn file 20 MiB, request-level bound, allowlist + magic-byte validation và exact-key compensation.
- Cumulative quota được đưa sang một quyết định riêng sau khi có policy retention, số liệu usage và yêu cầu capacity.

### Hệ quả và đánh đổi

- Tránh mở rộng schema/credit/storage policy khi chưa có dữ liệu và chưa được phê duyệt.
- Per-request controls không ngăn một user hợp lệ tải nhiều request nhỏ; deployment access policy và monitoring vẫn cần thiết.
- Trước production scale phải xác định quota window, owner scope, hành vi khi vượt quota, cleanup và idempotency/concurrency.

### Không chọn

- Gắn quota upload tạm thời vào credit ledger hiện tại.
- Thêm một giới hạn cộng dồn tùy ý mà chưa có lifecycle và capacity policy.

## ADR-005 — Renderer staging dùng application token và IAM theo prefix

- **Trạng thái:** Accepted
- **Ngày xác nhận:** 2026-07-19
- **Phạm vi:** Checkpoint 2.4B — Cloud Run/GCS renderer staging

### Bối cảnh

Renderer client hiện gửi shared secret trong `X-Renderer-Token` nhưng caller Sites/Cloudflare chưa mint Google-signed ID token cho Cloud Run. Giữ Cloud Run private bằng IAM sẽ chặn request trước khi tới renderer. Staging dùng một bucket private với các prefix `input/`, `output/` và `failed/`; extraction v2 cần cập nhật durable operation record bằng generation precondition, nên `objectCreator` đơn thuần không đủ.

### Quyết định

- Staging Cloud Run cho phép platform-level unauthenticated invocation và dùng `ingress=all`; mọi endpoint xử lý media vẫn bắt buộc shared secret qua `X-Renderer-Token`.
- Health endpoint không yêu cầu token và không nhận media hoặc dữ liệu user.
- Giới hạn staging ở concurrency 1, min instance 0 và max instance 1 để chặn scale ngoài ý muốn khi endpoint có thể bị Internet chạm tới.
- GCS bật uniform bucket-level access và public access prevention; anonymous object access phải bị từ chối.
- Runtime service account có quyền đọc object staging và `roles/storage.objectUser` với IAM condition chỉ áp dụng dưới `output/`; không giữ quyền tạo object không điều kiện trên toàn bucket.
- Secret được lấy từ Secret Manager và pin theo version; không ghi token vào source, command output hoặc log.
- Chưa cấu hình Studio gọi renderer khi provider còn mock; canary gọi trực tiếp bằng private GCS URI.

### Hệ quả và đánh đổi

- Không đổi renderer API contract, provider boundary hoặc continuity contract trong 2.4B.
- Request thiếu/sai token bị từ chối ở application layer, nhưng vẫn có thể làm Cloud Run nhận request và phát sinh chi phí/DoS giới hạn; max instance 1 chỉ giảm chứ không loại bỏ rủi ro.
- Một secret bị lộ có thể gọi renderer staging; trước production scale nên thêm Google ID-token/WIF hoặc một ingress bảo vệ tương đương.
- IAM theo prefix cho phép extraction v2 cập nhật operation record mà không trao quyền sửa `input/`.
- `/extract-last-frame` v2 replay idempotent; `/render` vẫn cần một quyết định riêng về durable idempotency và retry.

### Không chọn

- Giữ `--no-allow-unauthenticated` trong khi caller không có Google ID token rồi coi integration là hoạt động.
- Cấp `Storage Admin`, `Editor` hoặc quyền ghi không giới hạn cho renderer runtime service account.
- Bật renderer trong Studio mock và gửi URI `mock://` tới Cloud Run.

## ADR-006 — Versioned Scene Contracts dùng schema planning hiện có

- **Trạng thái:** Accepted
- **Ngày xác nhận:** 2026-07-22
- **Phạm vi:** Checkpoint 2.5A — Product Truth and Scene Contracts

### Bối cảnh

Storyboard MVP trước đây tạo bốn beat generic trực tiếp trong API route, biên dịch prompt bằng một hàm nối chuỗi và xóa active scene rows khi lập lại. Schema ban đầu đã có `storyboards`, `prompt_versions` và `scenes.storyboard_id`, nhưng các bảng/liên kết này chưa được dùng. Unique index hiện tại trên `(scenes.project_id, scenes.scene_index)` chỉ cho phép một projection bốn cảnh hoạt động cho mỗi project; generation jobs và renders cũng chưa lưu trực tiếp storyboard/prompt version.

### Quyết định

- Scene planning dùng `SceneContract` provider-neutral, serializable và có version. Contract chứa visual state đầu/cuối, một primary action, motion, background policy, `visualStyle`, `audioDirection`, continuity locks, generation mode, risk factors và stable-end requirement.
- Project mới phải nhận bảy trường Story Bible cụ thể qua API/UI. Create/PATCH và planner cùng từ chối generic placeholder hoặc claim về reference chưa bind; legacy project thiếu product truth phải được bổ sung trước khi plan.
- Planner bốn cảnh trong 2.5A là deterministic rules, có version rõ ràng và không được mô tả là AI/LLM planner.
- `storyboards.compiled_json` giữ Story Bible snapshot và bốn authoritative Scene Contracts. Mỗi lần lập lại tạo row/version mới; row cũ chỉ chuyển từ `active` sang `superseded`, không bị xóa hoặc ghi đè compiled JSON.
- `prompt_versions` giữ raw/compiled prompt cho từng scene. `assumptions_json` chứa exact positive/negative compiled payload, compiler version, generation mode, target provider, compiler config và lint issues; không cần thay đổi schema.
- `scenes` chỉ là active projection và liên kết tới authoritative version qua `storyboard_id`. Scene reads được enrich từ storyboard/prompt history; legacy rows nhận contract compatibility version `0`.
- Replan có scene `approved` bắt buộc `confirmApprovedReplacement: true`. Nếu project đã có bất kỳ generation job hoặc final render history nào, 2.5A từ chối replan kể cả đã xác nhận để không xóa scene rows mà job/render cũ đang tham chiếu.
- Provider request, renderer contract, credit ledger, manual QC, private media và extraction v2 không thay đổi trong checkpoint này.

### Hệ quả và đánh đổi

- Không cần migration hoặc backfill phá hủy; schema/bootstrap hiện có đủ cho authoritative planning history và active projection.
- D1 batch cập nhật status, tạo version, thay projection, ghi prompt versions và cập nhật project như một đơn vị atomic; concurrent replans tuần tự hóa thành các version riêng và chỉ còn một projection active.
- Lịch sử contract/prompt được giữ đầy đủ, nhưng 2.5A chưa có immutable scene candidate/attempt linkage. Vì vậy project đã thực thi generation/render không thể replan an toàn; khả năng này phải chờ data model provenance ở checkpoint sau.
- First-frame compiler có mặt và Scene 2–4 khai báo mode tương ứng, nhưng reference binding, boundary keyframes và `lastFrameUri` vẫn chưa được triển khai.
- `visualStyle` được render trực tiếp trong text-to-video và giữ như continuity direction ở image-guided modes; `audioDirection` được render trong cả bốn mode vì provider generation hiện bật audio.

### Không chọn

- Thêm migration chỉ để duplicate các cột đã tồn tại.
- Lưu Scene Contract bằng cách nhồi JSON vào các cột text `start_state`/`end_state`.
- Xóa storyboard hoặc prompt history khi lập lại.
- Cho replan project đã có job/render rồi để lại foreign reference logic sai version.
- Đưa provider-specific asset/keyframe fields vào Scene Contract trong 2.5A.
