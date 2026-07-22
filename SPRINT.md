# SPRINT.md — SceneFlow AI Studio

## Checkpoint 2.3 — Manual QC và private scene media

**Trạng thái:** Hoàn tất · Gate Re-Review PASS

**Ngày chốt baseline:** 2026-07-17

### Mục tiêu

Cho phép người dùng xem đầu ra từng cảnh, tự duyệt hoặc từ chối QC và tiếp tục pipeline mà không phá invariant continuity: cảnh sau chỉ được tạo khi cảnh trước đã được duyệt và có frame cuối hợp lệ.

### Phạm vi đã hoàn thành

- UI từng cảnh có video preview, hành động duyệt/từ chối/tạo lại và lý do khóa rõ ràng.
- Nút duyệt chỉ hoạt động khi có cả video đầu ra và continuity frame.
- Pipeline dừng ở manual QC hoặc generation đang chạy, không gửi thêm scene ngoài ý muốn.
- Regeneration giữ đúng dependency chain và khóa các cảnh downstream.
- Scene media kiểm tra auth và ownership trước khi trả dữ liệu; mock media vẫn redirect `307`.
- GCS scene media chỉ nhận một byte range hợp lệ, khóa ma trận `200`/`206`/`416`, chỉ stream `video/mp4` và không lộ body lỗi upstream.
- README mô tả endpoint và contract scene media.

### Bằng chứng Gate

- Targeted contract suite: **52/52 PASS**.
- `npm run verify`: lint sạch, production build thành công, **141/141 test/subtest PASS** và renderer syntax hợp lệ.
- Runtime integration xác nhận unauthenticated `401`, non-owner `404`, mock redirect `307` kể cả với multi-range malformed, và MP4 mock đọc được.
- Route-level spy xác nhận invalid GCS Range trả local `416` với **0 lần gọi upstream**.
- Independent re-review: UI policy PASS; GCS contract PASS; không còn blocker Checkpoint 2.3.

### Ranh giới được giữ nguyên

- Không đổi schema/migration D1.
- Không đổi Veo provider selection hoặc contract Studio ↔ renderer.
- Không đổi credit ledger, ownership pattern hoặc cách ghi R2.
- Không triển khai hay thay đổi tài nguyên Google Cloud.

### Ngoài phạm vi baseline

- Xác minh và khóa trust boundary của auth header tại Worker origin.
- Áp contract Range/MIME an toàn cho final-render media route.
- Magic-byte, request cap, quota và orphan cleanup cho asset upload.
- Cloud Run/GCS staging, real Veo E2E, production queue, observability và media lifecycle.

## Checkpoint 2.4 — Production Trust Boundary & E2E Readiness

**Trạng thái:** Đang thực hiện. Gate local 2.4A PASS và production đã được publish; edge probes unauthenticated/header-spoof PASS. Renderer Cloud Run/GCS staging 2.4B đã deploy và canary PASS. Real Veo staging 2.4C Gate 1–2 đã PASS; trong Gate 3, cảnh 3 và preview cứu hộ cảnh 4 đã được owner approve. Generation đã dừng tại ~100.000/120.000 VND. Artifact cứu hộ đã được khóa checksum, upload private và dùng để render đủ bốn cảnh; final render đã PASS kiểm tra kỹ thuật, quyền riêng tư và HTTP Range. Gate 3 còn chờ owner xem toàn bộ final render; các kiểm tra SIWC tương tác cũng chưa hoàn tất.

Thứ tự đề xuất: auth origin → final-render media → asset ingestion → Cloud Run/GCS staging → real Veo E2E → queue/observability/lifecycle.

### Checkpoint 2.4A — Security gate

**Ngày hoàn tất implementation local:** 2026-07-18

#### Phạm vi đã hoàn thành

- Chốt trust boundary dùng Sites dispatcher sở hữu SIWC, giữ `access_mode=custom` và không thêm auth stack riêng trong SceneFlow.
- Ghi rõ invariant không được để raw Worker origin trở thành đường public bypass dispatcher.
- Final-render media dùng cùng helper/chính sách strict Range, MIME và safe upstream error như scene media.
- Asset upload áp hard request cap trước hoặc trong khi parse multipart bằng counting stream, giữ giới hạn 20 MiB/file và xác minh magic bytes JPG/PNG/WebP.
- MIME và extension lưu trữ lấy từ file signature đã phát hiện, không lấy từ filename.
- Nếu R2 put thành công nhưng ghi metadata thất bại, route thử xóa bù đúng object key vừa tạo; lỗi cleanup không lộ chi tiết nội bộ.
- Quota cộng dồn theo user/project được hoãn sang phase lifecycle/capacity; không đổi schema trong 2.4A.

#### Bằng chứng Gate local

- Targeted suites mới: **39/39 test/subtest PASS** cho final-render media, asset validation, bounded multipart và asset route failure compensation.
- `npm run verify`: lint sạch, production build thành công, **180/180 test/subtest PASS** và renderer syntax hợp lệ.
- Invalid hoặc multi-range final-render trả local `416` với 0 lần gọi GCS; upstream status/MIME/header sai được thu gọn thành safe `502`.
- Request upload quá cap hoặc MIME/signature sai không chạm R2; DB failure sau R2 put gọi exact-key delete.
- Không đổi schema/migration D1, provider selection, renderer contract, credit ledger hoặc continuity chain.

#### Kết quả publish và gate deployment

- Production Sites đã publish ngày 2026-07-18 từ đúng commit 2.4A; access policy vẫn là `custom`, chỉ một user được phép và không có group.
- Request API chưa đăng nhập trả `403`; request tự gắn `oai-authenticated-user-*` cũng trả `403`, nên spoofed identity header không bypass dispatcher public.
- Phiên browser automation không thuộc allowlist và nhận `Access Denied`, đúng với custom access policy nhưng không thay thế kiểm tra bằng phiên owner thật.
- Còn phải xác nhận owner flow, non-owner flow, logout/session-expiry và direct-origin reachability bằng phiên/môi trường triển khai phù hợp trước khi coi toàn bộ deployment gate đã đóng.

### Checkpoint 2.4B — Cloud Run/GCS renderer staging

**Ngày hoàn tất staging canary:** 2026-07-19

#### Phạm vi đã hoàn thành

- Dùng project staging `project-c23ce61c-905d-4b2d-8e1` (`194278159531`) và region `us-central1`; không tạo project, bucket hoặc service trùng.
- Nâng renderer container từ Node.js 20 EOL lên Node.js 22 và chép đủ `extraction-operation.mjs` vào image.
- Thêm test bảo đảm mọi local ESM import của `server.mjs` đều có trong Dockerfile và container tiếp tục chạy bằng non-root user.
- Deploy revision `sceneflow-renderer-staging-2-4b-01` từ image digest `sha256:b9c9afaf3253a6875af2c2ddc364e2d5d91f93b941accdbda7ab8f11f17647a5`; canary 0% traffic PASS trước khi promote 100%.
- Giữ cấu hình staging có giới hạn: gen2, 2 CPU, 4 GiB, concurrency 1, min instance 0, max instance 1, tối đa 4 clip và 256 MiB tổng input.
- Bucket bật uniform bucket-level access, public access prevention, soft delete 0 và lifecycle tự xóa `input/` sau 3 ngày, `output/`/`failed/` sau 7 ngày.
- Runtime service account chỉ đọc media staging và có `roles/storage.objectUser` kèm IAM condition giới hạn write/update dưới `output/`; secret version 2 được pin qua Secret Manager.

#### Bằng chứng Gate

- Container smoke test: health `200`, thiếu token `401`, token đúng đi qua auth, Node `22.23.1`, FFmpeg `5.1.9`, extraction module có trong image.
- Render thật ghép 4 clip với fade thành MP4 H.264 `1080×1920`, `yuv420p`, 24 fps; AAC 48 kHz stereo; duration `31.458333s`.
- Extraction v2 lần đầu trả `201 created`, cùng binding trả `200 replayed` với cùng generation, binding khác trả `409 idempotency_conflict`.
- GCS output ẩn danh trả `403`; authenticated byte range trả `206` đúng 32 byte và MIME `video/mp4`.
- Log revision chỉ ghi các request/status dự kiến, không ghi renderer token.
- `npm run verify`: lint sạch, production build thành công, **182/182 test/subtest PASS** và renderer syntax hợp lệ.

#### Ranh giới và việc còn lại

- Studio/Sites vẫn chạy mock và chưa được cấu hình gọi renderer staging; tránh gửi URI `mock://` tới Cloud Run.
- Cloud Run staging dùng public invoker ở lớp platform vì caller hiện chưa mint Google ID token; mọi endpoint xử lý media vẫn bắt buộc `X-Renderer-Token`, và max instance 1 giới hạn rủi ro chi phí/DoS.
- `/extract-last-frame` v2 có durable idempotency; `/render` chưa replay idempotent khi output đã tồn tại và chưa có production retry queue.
- Real Veo E2E, Worker credential đọc GCS, monitoring/alerting đầy đủ và production capacity test chưa thuộc gate này.

### Checkpoint 2.4C — Real Veo E2E staging

**Trạng thái:** Gate 1 PASS. Gate 2 PASS ngày 2026-07-22: extraction continuity hoạt động, cảnh 2 lần đầu bị reject vì có bàn tay ngoài ý muốn, lần regenerate đã loại lỗi và được owner approve. Trong Gate 3, cảnh 3 và preview cứu hộ cảnh 4 đã được owner approve. Generation đã dừng ở ~100.000/120.000 VND. Preview cứu hộ đã được upload private với checksum khớp và final render bốn cảnh đã PASS kiểm tra kỹ thuật, quyền riêng tư và HTTP Range; owner playback QC cuối vẫn đang chờ.

#### Gate 1 — Một cảnh Veo Fast thật

- Bật Vertex AI API và Service Account Credentials API trong đúng staging project `project-c23ce61c-905d-4b2d-8e1`.
- Tạo caller riêng `sceneflow-veo-stg`; caller chỉ có `roles/aiplatform.user`, dùng impersonation token ngắn hạn và không tạo service-account key lâu dài.
- Giới hạn quyền GCS bằng IAM condition dưới `input/veo/`; Vertex AI service agent chỉ có `roles/storage.objectUser` trong prefix này.
- Chạy đúng một output thành công với model `veo-3.1-fast-generate-001`: dọc `1080×1920`, 8 giây, H.264 24 fps, AAC 48 kHz stereo, MP4 7.513.267 byte.
- Veo trả `raiMediaFilteredCount = 0`; object được lưu dưới `input/veo/checkpoint-2-4c/` và truy cập ẩn danh trả `403`.
- Lần submit đầu bị từ chối trước khi model chạy vì Vertex AI service agent đang được provision; không sinh output. Sau khi provision service agent, retry tạo thành công một video thực tế.
- Ngân sách checkpoint được duyệt tối đa 250.000 VND; budget hiện là cảnh báo chi phí, không phải hard cap. Không gửi thêm generation trong Gate 1.

#### Ranh giới và việc còn lại

- Gate 1 chỉ chứng minh Vertex AI → private GCS hoạt động; chưa chứng minh frame-anchor continuity, manual QC, render cuối hoặc private playback trong một luồng xuyên suốt.
- Chưa đổi credit ledger/schema và chưa nối `VEO_PROVIDER=google` hoặc `RENDER_SERVICE_*` vào Sites production.

#### Gate 2 — Continuity hai cảnh

- Renderer extraction v2 tạo mới thành công (`201 created`) frame cuối cảnh 1 dưới deterministic path, JPEG `1080×1920`, 183.809 byte, đầy đủ binding metadata và truy cập ẩn danh trả `403`.
- Vertex AI service agent được cấp `roles/storage.objectViewer` với IAM condition chỉ đọc prefix frame của Checkpoint 2.4C; không có quyền sửa/xóa frame renderer tạo.
- Tạo đúng một cảnh 2 từ frame anchor bằng `veo-3.1-fast-generate-001`; Veo trả `raiMediaFilteredCount = 0` và private GCS MP4 thành công.
- Cảnh 2 là `1080×1920`, 8 giây, H.264 24 fps, AAC 48 kHz stereo, 7.645.305 byte; truy cập ẩn danh trả `403`.
- Frame mở đầu cảnh 2 khớp mạnh với anchor, SSIM tổng `0,953927`; cốc, tay cầm, mặt bàn, ánh sáng và bố cục chính được nối liên tục.
- Automated visual sampling mỗi giây phát hiện một bàn tay/ngón tay xuất hiện cạnh tay cầm khoảng giữa cảnh dù prompt yêu cầu không có người; owner đã **reject** kết quả lần đầu.
- Regenerate đúng một lần từ cùng anchor với camera gần như tĩnh và prompt cấm rõ người/tay/ngón tay. Kết quả mới là private MP4 `1080×1920`, 8 giây, H.264 24 fps, AAC 48 kHz stereo, 8.518.835 byte; `raiMediaFilteredCount = 0` và anonymous access trả `403`.
- Frame mở đầu bản regenerate vẫn nối tốt với anchor, SSIM tổng `0,951685`; sampling tám khung mỗi giây không còn bàn tay/người/vật thể mới, cốc giữ một tay cầm và không đổi hình. Automated QC khuyến nghị **approve** và owner đã approve kết quả này.
- Tổng generation thành công tới thời điểm này là ba clip Fast 1080p × 8 giây có audio, giá niêm yết ước tính `2,88 USD` trước thuế/tỷ giá; vẫn dưới ngân sách checkpoint 250.000 VND.

#### Ranh giới và việc còn lại

- Gate 2 đã PASS manual QC; bản regenerate là output cảnh 2 được chấp nhận, bản bị reject không được dùng làm continuity source cho bước sau.
- Không chạy cảnh 3–4 khi chưa có xác nhận Gate 3 riêng của owner.
- Chưa đổi credit ledger/schema và chưa nối `VEO_PROVIDER=google` hoặc `RENDER_SERVICE_*` vào Sites production.

#### Gate 3 — Hoàn tất bốn cảnh và final render

- Owner duyệt hard cap riêng tối đa 120.000 VND và yêu cầu dừng ngay trước khi vượt mức. Gate 3 đã tạo bốn clip Veo Fast, ước tính khoảng `3,84 USD`/~100.000 VND; còn khoảng 20.000 VND trong cap. Generation đã dừng và không gửi thêm clip.
- Renderer extraction v2 tạo mới thành công (`201 created`) frame cuối cảnh 2 đã duyệt dưới deterministic path, JPEG `1080×1920`, 234.371 byte, đầy đủ binding metadata và truy cập ẩn danh trả `403`.
- Tạo đúng một cảnh 3 từ frame anchor bằng `veo-3.1-fast-generate-001`; Veo trả `raiMediaFilteredCount = 0` và private GCS MP4 thành công.
- Cảnh 3 là `1080×1920`, đúng 8 giây, H.264 24 fps, AAC 48 kHz stereo, 7.279.608 byte; truy cập ẩn danh trả `403`.
- Frame mở đầu cảnh 3 có SSIM tổng `0,913369` so với anchor. Sampling tám khung mỗi giây không thấy người, bàn tay hoặc vật thể mới; cốc và tay cầm giữ hình ổn định. Chuyển động chỉ gồm hơi nước, ánh sáng và thay đổi focus nhẹ; automated QC khuyến nghị **approve**.
- Owner đã approve cảnh 3. Renderer extraction v2 tiếp tục tạo thành công (`201 created`) frame cuối cảnh 3, JPEG `1080×1920`, 242.590 byte, đầy đủ binding metadata và truy cập ẩn danh trả `403`.
- Tạo đúng một cảnh 4 từ frame anchor bằng `veo-3.1-fast-generate-001`; Veo trả `raiMediaFilteredCount = 0`. Cảnh 4 là private MP4 `1080×1920`, đúng 8 giây, H.264 24 fps, AAC 48 kHz stereo, 5.867.442 byte; truy cập ẩn danh trả `403`.
- Frame mở đầu cảnh 4 nối tốt với anchor, SSIM tổng `0,940981`; cốc, tay cầm, mặt bàn và bố cục giữ ổn định. Tuy nhiên sampling và kiểm tra phóng to các frame `6,25–7,75` giây thấy một bóng có nhiều nhánh giống bàn tay/ngón tay đi vào mép trên bên trái. Automated visual QC khuyến nghị **reject** và owner đã reject bản này.
- Regenerate đúng một lần từ cùng anchor với `personGeneration=dont_allow`, background khóa hoàn toàn và prompt cấm mọi vật thể đi vào từ mép khung. Veo trả `raiMediaFilteredCount = 0`; output là private MP4 `1080×1920`, đúng 8 giây, H.264 24 fps, AAC 48 kHz stereo, 5.030.033 byte; anonymous access trả `403`.
- Frame đầu bản regenerate vẫn nối tốt với anchor, SSIM tổng `0,938439`. Sampling 16 khung và kiểm tra chi tiết cho thấy artifact cuối đã biến mất, nhưng một khối tối lớn đi vào mép trên bên trái khoảng `0,25–0,75` giây rồi biến mất. Đây là vật thể mới và làm hỏng continuity dù không còn hình bàn tay rõ; automated visual QC tiếp tục khuyến nghị **reject** và owner đã reject bản này.
- Generation cuối dùng cùng anchor cho cả `image` và `lastFrame`, `personGeneration=dont_allow` và prompt khóa mọi mép khung. Output private MP4 `1080×1920`, đúng 8 giây, H.264 24 fps, AAC 48 kHz stereo, 4.314.788 byte; `raiMediaFilteredCount = 0`, anonymous access `403`. SSIM anchor với frame đầu/cuối lần lượt `0,928652`/`0,925645`. Camera/cốc được khóa nhưng hơi nước biến thành hình giống bàn tay phía sau cốc trong phần lớn video; automated QC **reject**.
- Không gọi Veo thêm. Tạo preview cứu hộ: lấy `0–1` giây sạch của bản cảnh 4 đầu và `1–8` giây sạch của bản regenerate, dùng một track audio liền mạch. Output đúng 8 giây, `1080×1920`, H.264/AAC, 3.902.900 byte; SSIM anchor→frame đầu `0,941593`, SSIM hai frame kề điểm ghép `0,955807`. Sampling 16 khung không còn artifact đi vào mép hoặc hình bàn tay rõ; automated QC khuyến nghị **approve** và owner đã approve.
- Artifact đã duyệt được upload nguyên byte lên private GCS tại `gs://sceneflow-staging-media-project-c23ce61c-905d-4b2d-8e1/input/veo/checkpoint-2-4c/approved/scene4-salvage-b3f5a77ee9e80f8d.mp4`; SHA-256 local/round-trip cùng là `B3F5A77EE9E80F8D421D59440081BFC604C5630543CC1FE0FD84E60E2EA2056A`, generation `1784725555312693`, anonymous access trả `403`.
- Renderer nhận manifest bốn cảnh và trả `200` cho request `render_gate3_approved_20260722-200806`. Final render private nằm tại `gs://sceneflow-staging-media-project-c23ce61c-905d-4b2d-8e1/output/projects/prj_checkpoint24c/renders/checkpoint-2-4c-gate3-approved-20260722-200806.mp4`: 32 giây, `1080×1920`, H.264 24 fps, AAC 48 kHz stereo, 17.907.927 byte; SHA-256 `C599CE8EC24A8C85F5402AEE721E52D8F6F40F8F2C10FC1BFDC3630E29E252AF` và anonymous access trả `403`.
- Authenticated byte-range probe trả `206`, `Content-Range: bytes 0-1023/17907927`, `Content-Length: 1024`. Automated playback QC không phát hiện black interval hoặc silence interval dài từ một giây; contact sheets không có khung trống. Một vùng nền tối rộng xuất hiện gần các mốc nối `16` và `24` giây từ các scene source đã được owner approve trước đó, nên Gate 3 vẫn chờ owner xem toàn bộ final render trước khi đóng.
- Sites production vẫn dùng mock và không bị thay đổi trong Gate 3.

### Bước tiếp theo

Owner xem toàn bộ final render bốn cảnh. Nếu approve, đóng Gate 3 ở trạng thái PASS; nếu reject, ghi nhận Gate 3 chưa đạt và không gửi generation mới vì generation đã dừng trong hard cap. Hoàn tất riêng các kiểm tra SIWC tương tác còn lại; chỉ nối `RENDER_SERVICE_*` vào Studio khi scene source đã là `gs://` hoặc HTTPS hợp lệ.

## Checkpoint 2.5A — Product Truth and Scene Contracts

**Trạng thái:** Independent QA lần đầu FAIL; correction implementation local hoàn tất và chờ re-review

**Ngày implementation:** 2026-07-22

**Ngày correction:** 2026-07-22

### Phạm vi đã triển khai

- Thêm `SceneContract` provider-neutral có version, structured visual state đầu/cuối, primary action, motion, background policy, continuity locks, generation mode, risk factors và stable-end requirement.
- Thay beat/prompt concatenation trong storyboard route bằng deterministic planner bốn cảnh và mode-aware compiler. Scene 1 dùng `text_to_video`; Scene 2–4 tiếp tục dùng `first_frame`, đúng workflow last-frame chaining hiện tại.
- Thêm prompt lint cho multiple/sequential actions, camera conflict, locked-camera conflict, stable end, continuity locks, generic Story Bible locks và static-content repetition trong image-guided prompt.
- Kích hoạt `storyboards`, `prompt_versions` và `scenes.storyboard_id` đã có sẵn; không tạo migration. `compiled_json` giữ authoritative contracts, prompt metadata giữ compiler version và scene rows chỉ là active projection.
- Replan tạo version mới và giữ authoritative history. Approved projection cần explicit confirmation; project có bất kỳ job/render history nào bị chặn replan để tránh orphan hoặc wrong-version reference trong schema hiện tại.
- UI bỏ tuyên bố “AI hiểu ý bạn”, hiển thị deterministic compiler/planner version, Scene Contract fields và model thật trả về từ generation job.

### Independent QA findings và correction

- **Finding 1 — Product Truth runtime:** `POST /api/projects` và `PATCH /api/projects/:id` nhận/validate bảy trường Story Bible cụ thể. Generic placeholder và claim về reference/ảnh chưa bind trả `400 invalid_story_bible`; planner validate lại trước khi tạo storyboard. Project có execution history không được đổi Story Bible.
- **Finding 2 — style/audio regression:** Scene Contract v2 giữ `visualStyle` và `audioDirection`. Compiler v2 đưa cả hai vào text-to-video; first-frame giữ style continuity mà không lặp static state và vẫn có audio; first/last-frame và reference-guided vẫn có audio direction.
- **Finding 3 — incomplete prompt history:** `prompt_versions.assumptions_json` giữ exact compiled payload gồm positive prompt, negative prompt, generation mode, compiler version, target provider, compiler config và lint issues. Replan không xóa payload của version cũ.
- **Finding 4 — UI overclaim:** bỏ `Identity locked`; UI dùng “Đã lập kế hoạch nhận dạng”, đổi continuity panel thành kế hoạch và ghi rõ ảnh private chưa được bind vào Veo.
- Không có migration, provider request, renderer contract, reference binding, paid call hoặc Cloud change.

### Ranh giới giữ nguyên

- Không đổi provider request; `lastFrameUri` vẫn là `null` và previous approved end frame vẫn đi vào `startFrameUri`.
- Không reference asset binding, R2→GCS promotion, boundary keyframe, paid Veo call, durable workflow/queue, semantic QC/repair/escalation hoặc Render v2.
- Không đổi ownership/auth, atomic generation admission, credit debit/refund, manual QC, downstream invalidation, private media hoặc extraction v2.

### Bằng chứng local correction

- Targeted unit/UI/generation regression gồm Story Bible validation, bốn compiler mode, style/audio và UI policy: PASS.
- Targeted Wrangler/D1 integration: **27/27 PASS** ở lần chạy correction đầu; bao phủ project create/PATCH, Story Bible snapshot, concrete scene-1 prompt, full prompt-history preservation, ownership, replan guards và pipeline regressions.
- Production build: PASS.
- Targeted correction suite cuối: **28/28 PASS**.
- Wrangler/D1 integration sau fix PASS ba lần liên tiếp (hai standalone và một lần trong full suite), mỗi lần **27/27**.
- Full `npm run verify`: lint sạch, production build thành công, **204/204 test/subtest PASS** và renderer syntax check hợp lệ.

### Điều tra transient 198/200

- Subtest chính xác: `approved storyboard requires explicit confirmation before replan`; lỗi `TypeError: fetch failed`. Parent suite cũng fail nên tổng đếm giảm từ 200 xuống 198.
- Tái hiện được trên commit ban đầu khi subtest gọi HTTP ngay sau `wrangler d1 execute --local` chạy bằng một process thứ hai trên cùng persistence directory mà Wrangler dev đang dùng. Tất cả subtest sau tiếp tục PASS, chứng minh runtime chỉ gián đoạn tạm thời chứ replan state không sai.
- Correction đổi SQL mutation helper thành async, chờ hai health probe liên tiếp sau mỗi out-of-process D1 mutation, và chỉ retry bounded cho network/HTML-503 transient; JSON application error không bị retry hoặc che giấu.
- Runtime integration, full parallel suite và final `npm run verify` sau correction đều PASS. GitHub CI evidence được kiểm tra sau khi push correction commit.

### Hạn chế đã biết

- 2.5A chưa có immutable generation attempt/candidate binding, nên không cho replan project đã có job/render history.
- `reference_guided` và `first_last_frame` mới có deterministic compiler/test; active four-scene plan chưa dùng hai mode này.
- Production Sites chưa deploy checkpoint này và vẫn dùng mock.
- Correction chỉ chờ independent re-review; không bắt đầu Checkpoint 2.5B.
