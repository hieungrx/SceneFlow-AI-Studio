# SceneFlow AI Studio — Tổng quan sản phẩm

## Dự án giải quyết vấn đề gì?

SceneFlow AI Studio giúp người dùng biến một ý tưởng hoặc brief thành video AI hoàn chỉnh, đồng thời giữ nhân vật, sản phẩm và bối cảnh nhất quán giữa các cảnh.

Khi tạo video AI dài bằng các công cụ rời rạc, người dùng thường phải tự viết prompt cho từng cảnh, theo dõi nhiều file video ngắn, kiểm tra chất lượng thủ công và dùng một phần mềm khác để ghép video. Nhân vật hoặc sản phẩm cũng dễ thay đổi hình dáng giữa các lần tạo, làm video thiếu liền mạch và gây lãng phí credit.

SceneFlow gom những công việc này thành một quy trình sản xuất có kiểm soát.

## Quy trình người dùng

```text
Brief
→ Deterministic brief preview
→ Versioned Story Bible snapshot
→ Storyboard + Scene Contracts
→ Tạo từng cảnh
→ Kiểm tra chất lượng
→ Giữ continuity
→ Ghép video hoàn chỉnh
```

1. Người dùng nhập brief và tài liệu tham chiếu cho video.
2. Hệ thống hiển thị deterministic brief preview; Checkpoint 2.5A chưa dùng LLM planner.
3. Người dùng nhập Story Bible cụ thể cho nhân vật, sản phẩm, bối cảnh, ánh sáng, visual style, audio direction và must-avoid; generic lock/reference claim chưa bind bị từ chối.
4. Deterministic planner tạo storyboard version gồm bốn structured Scene Contracts có quan hệ phụ thuộc; mode-aware compiler giữ style/audio và tạo full positive/negative prompt history cho từng cảnh.
5. Video được tạo tuần tự theo từng cảnh; provider contract hỗ trợ 4, 6 hoặc 8 giây, còn storyboard MVP hiện dùng 8 giây.
6. Người dùng duyệt hoặc từ chối từng cảnh tại bước QC.
7. Frame cuối của cảnh trước được dùng làm điểm neo continuity cho cảnh sau.
8. Nếu một cảnh được tạo lại, các cảnh phụ thuộc phía sau sẽ bị vô hiệu hóa và cần tạo lại.
9. Khi tất cả cảnh vượt QC, hệ thống tạo kế hoạch render và ghép thành video 1080p.

## Giá trị cốt lõi

- Giữ hình ảnh nhân vật, sản phẩm và bối cảnh nhất quán giữa các cảnh.
- Ngăn tạo cảnh sai thứ tự bằng dependency chain và quality gate.
- Giảm số lần tạo lại và hạn chế lãng phí credit.
- Cho phép người dùng kiểm soát chất lượng trước khi pipeline đi tiếp.
- Quản lý tập trung project, tài sản, job tạo video và kết quả render.
- Tách video provider khỏi giao diện để có thể chuyển giữa mock và Google Veo mà không đổi workflow.
- Tách renderer FFmpeg thành dịch vụ độc lập để ghép video mà không phụ thuộc vào runtime chính.

## Trạng thái hiện tại

Checkpoint 2.3 đã hoàn thành nền tảng MVP gồm Studio UI, Story Bible, storyboard bốn cảnh, pipeline tạo cảnh tuần tự, manual QC, continuity anchor, D1/R2, ownership checks, credit ledger, mock Veo, Google Veo adapter và renderer contract. Gate local 2.4A đã bổ sung strict final-render media, bounded asset ingestion, magic-byte validation, exact-key R2 compensation và tài liệu trust boundary cho managed SIWC. Checkpoint 2.5A correction đã thay planning generic bằng concrete Story Bible validation, versioned Scene Contracts có style/audio, deterministic planner/compiler/lint, full authoritative storyboard/prompt history và active scene projection mà không đổi schema hoặc provider request; hiện đang chờ independent re-review.

Chế độ local không đăng nhập hiện phù hợp để kiểm tra giao diện và workflow mock. Người dùng có thể dựng storyboard, mô phỏng tạo cảnh, duyệt QC và kiểm tra cơ chế khóa/mở cảnh kế tiếp. Việc ghép trong chế độ này mới dừng ở render plan và video mẫu, chưa tạo một video dài mới từ các cảnh.

## Những phần cần hoàn thiện trước production

- Hoàn tất trust-boundary verification cho Sign in with ChatGPT trên deployment 2.4A: owner/non-owner, logout/session-expiry và direct-origin reachability. Production đã publish; unauthenticated/header-spoof edge probes đã PASS.
- Triển khai renderer FFmpeg lên Cloud Run và xác minh output GCS thật.
- Kiểm thử end-to-end với Google Veo thật.
- Bổ sung queue production, rate limit, retry và dead-letter handling.
- Hoàn thiện QC tự động thay cho phần lớn workflow mô phỏng hiện tại.
- Bổ sung theo dõi chi phí, log, metric và cảnh báo.
- Xây dựng chính sách hết hạn và xóa media.
- Tăng độ phủ test cho authorization, provider errors và concurrency production.

## Tuyên bố sản phẩm ngắn gọn

> SceneFlow biến nhiều đoạn video AI rời rạc thành một quy trình sản xuất video dài có kiểm soát chất lượng và continuity.
