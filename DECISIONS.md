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
