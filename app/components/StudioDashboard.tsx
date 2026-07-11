"use client";

import { useMemo, useState } from "react";
import type { AssetKind, GenerationJob, PromptCompilation, Scene } from "../../lib/types";

type StudioDashboardProps = {
  userName: string;
  signedIn: boolean;
};

type ProjectResponse = { project: { id: string } };
type StoryboardResponse = { scenes: Scene[] };
type JobResponse = { job: GenerationJob; continuityReady?: boolean };
type RenderResponse = { render: { id: string; status: string; outputVideoUri?: string | null; renderer?: string; mediaUrl?: string | null } };

const navItems = [
  ["✦", "Studio", ""],
  ["▣", "Dự án", ""],
  ["↻", "Hàng đợi", "3"],
  ["◇", "Templates", "24"],
  ["◎", "Tài nguyên", ""],
] as const;

const demoScenes: Scene[] = [
  makeDemoScene(1, "Chuẩn bị hạt", "Barista đổ hạt vào máy xay và đưa tay đến nút bật.", "Ngón tay chạm nút, giữ yên 0,5 giây", "approved"),
  makeDemoScene(2, "Chiết xuất espresso", "Tiếp nối frame trước, espresso chảy vào đúng chiếc tách.", "Tách đầy 2/3, dòng espresso vừa dừng", "generating"),
  makeDemoScene(3, "Latte art", "Rót sữa thành hình trái tim, chuyển dần sang góc top-down.", "Tách ở giữa khung hình, mặt sữa ổn định", "waiting_previous"),
  makeDemoScene(4, "Hero shot & CTA", "Camera hạ xuống 45°, barista đẩy tách về phía người xem.", "Sản phẩm sắc nét, nhân vật mờ nhẹ phía sau", "planned"),
];

const demoJobs: GenerationJob[] = [
  makeDemoJob("job_demo_02", "scene_demo_02", "running", 63),
  makeDemoJob("job_demo_03", "scene_demo_03", "queued", 0),
];

export default function StudioDashboard({ userName, signedIn }: StudioDashboardProps) {
  const [activeNav, setActiveNav] = useState("Studio");
  const [projectName, setProjectName] = useState("TVC cà phê buổi sớm");
  const [brief, setBrief] = useState(
    "Nữ barista Việt Nam pha một tách latte trong quán nhỏ, cảm giác ấm áp và cao cấp.",
  );
  const [model, setModel] = useState("veo-3.1-lite");
  const [ratio, setRatio] = useState("9:16");
  const [optimized, setOptimized] = useState(false);
  const [compilation, setCompilation] = useState<PromptCompilation | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [scenes, setScenes] = useState<Scene[]>(demoScenes);
  const [jobs, setJobs] = useState<GenerationJob[]>(demoJobs);
  const [productFile, setProductFile] = useState<File | null>(null);
  const [characterFile, setCharacterFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("Bản trải nghiệm đã sẵn sàng — chưa tiêu tốn credit.");
  const [renderMediaUrl, setRenderMediaUrl] = useState<string | null>(null);

  const approvedScenes = useMemo(
    () => scenes.filter((scene) => scene.status === "approved").length,
    [scenes],
  );
  const runningJobs = jobs.filter((job) => job.status === "queued" || job.status === "running").length;
  const renderReady = scenes.length > 0 && scenes.every((scene) => scene.status === "approved");

  async function optimizePrompt() {
    if (optimized) {
      setOptimized(false);
      setNotice("Đang hiển thị brief gốc của bạn.");
      return;
    }
    setBusy(true);
    try {
      const { result } = await requestJson<{ result: PromptCompilation }>("/api/prompts/optimize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: brief, aspectRatio: ratio, durationSeconds: 8, model }),
      });
      setCompilation(result);
      setOptimized(true);
      setNotice("Prompt đã được cấu trúc lại; mọi giả định đều hiển thị để bạn kiểm soát.");
    } catch (error) {
      setNotice(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  async function submitProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!projectName.trim() || !brief.trim()) {
      setNotice("Hãy nhập tên dự án và ý tưởng video trước khi tiếp tục.");
      return;
    }
    if (!signedIn) {
      setScenes(demoScenes);
      setJobs(demoJobs);
      setNotice(`Đã dựng storyboard trải nghiệm cho “${projectName}”. Đăng nhập để lưu dự án.`);
      document.querySelector(".storyboard-panel")?.scrollIntoView({ behavior: "smooth" });
      return;
    }

    setBusy(true);
    try {
      const { project } = await requestJson<ProjectResponse>("/api/projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: projectName,
          brief,
          template: "KOC review sản phẩm",
          aspectRatio: ratio,
          targetDurationSeconds: 30,
          model,
        }),
      });
      setProjectId(project.id);

      const uploadResults = await Promise.allSettled([
        uploadReference(project.id, "product", productFile),
        uploadReference(project.id, "character", characterFile),
      ]);
      const failedUploads = uploadResults.filter((result) => result.status === "rejected").length;

      const storyboard = await requestJson<StoryboardResponse>(`/api/projects/${project.id}/storyboard`, {
        method: "POST",
      });
      setScenes(storyboard.scenes);
      setJobs([]);
      setNotice(
        failedUploads > 0
          ? `Đã tạo storyboard. ${failedUploads} ảnh chưa tải được; bạn vẫn có thể tiếp tục.`
          : `Đã lưu dự án và tạo ${storyboard.scenes.length} cảnh có liên kết.`,
      );
      window.setTimeout(
        () => document.querySelector(".storyboard-panel")?.scrollIntoView({ behavior: "smooth" }),
        60,
      );
    } catch (error) {
      setNotice(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  async function generateNext() {
    const runningDemo = scenes.find(
      (scene) => scene.status === "generating" && scene.id.startsWith("scene_demo"),
    );
    if (runningDemo) {
      simulateScene(runningDemo.id);
      return;
    }
    const target = scenes.find((scene, index) => {
      if (["approved", "queued", "generating"].includes(scene.status)) return false;
      return index === 0 || scenes[index - 1]?.status === "approved";
    });
    if (!target) {
      setNotice(renderReady ? "Tất cả cảnh đã hoàn tất. Bạn có thể ghép video." : "Cảnh tiếp theo đang chờ frame cuối của cảnh trước.");
      return;
    }
    await generateScene(target.id);
  }

  async function generateScene(sceneId: string) {
    if (!signedIn || sceneId.startsWith("scene_demo")) {
      simulateScene(sceneId);
      return;
    }
    setBusy(true);
    try {
      const target = scenes.find((scene) => scene.id === sceneId);
      const { job } = await requestJson<JobResponse>(`/api/scenes/${sceneId}/generate`, { method: "POST" });
      setJobs((current) => [job, ...current.filter((item) => item.sceneId !== sceneId)]);
      setScenes((current) => current.map((scene) => {
        if (scene.id === sceneId) return { ...scene, status: "queued" };
        if (target?.status === "approved" && scene.sceneIndex > target.sceneIndex) {
          return { ...scene, status: "waiting_previous", startFrameUri: null, endFrameUri: null, outputVideoUri: null, qualityScore: null };
        }
        return scene;
      }));
      setNotice("Cảnh đã vào hàng đợi Veo 3.1 Lite. Hệ thống sẽ tự kiểm tra tiến độ.");
      await pollJob(job.id, sceneId);
    } catch (error) {
      setNotice(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  async function pollJob(jobId: string, sceneId: string): Promise<GenerationJob | null> {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await delay(650);
      const { job, continuityReady } = await requestJson<JobResponse>(`/api/jobs/${jobId}`);
      setJobs((current) => current.map((item) => item.id === job.id ? job : item));
      setScenes((current) => current.map((scene) => scene.id === sceneId ? {
        ...scene,
        status: job.status === "done" ? (continuityReady === false ? "quality_check" : "approved") : "generating",
        outputVideoUri: job.status === "done" ? `mock://renders/${scene.projectId}/${scene.id}.mp4` : scene.outputVideoUri,
        qualityScore: job.status === "done" ? 94 : scene.qualityScore,
      } : scene));
      if (job.status === "done") {
        if (continuityReady === false) {
          setNotice("Video đã tạo xong nhưng chưa tách được frame cuối; pipeline dừng để tránh mất continuity.");
          return null;
        }
        setNotice("Cảnh đã qua QC và frame cuối đã được khóa cho cảnh tiếp theo.");
        return job;
      }
      if (job.status === "failed" || job.status === "canceled") return job;
    }
    return null;
  }

  async function runPipeline() {
    setBusy(true);
    try {
      if (!signedIn || scenes.every((scene) => scene.id.startsWith("scene_demo"))) {
        for (const scene of scenes) {
          if (scene.status === "approved") continue;
          setNotice(`Đang mô phỏng cảnh ${scene.sceneIndex}/${scenes.length} theo đúng thứ tự continuity.`);
          setScenes((current) => current.map((item) => item.id === scene.id ? { ...item, status: "generating" } : item));
          await delay(520);
          setScenes((current) => current.map((item) => item.id === scene.id ? { ...item, status: "approved", qualityScore: 94, endFrameUri: `mock://frame-${item.sceneIndex}.jpg`, outputVideoUri: `mock://${item.id}.mp4` } : item));
        }
        setJobs((current) => current.map((job) => ({ ...job, status: "done", progress: 100 })));
        setNotice("Pipeline hoàn tất: 4 cảnh đã duyệt, continuity 94/100 và sẵn sàng ghép.");
        return;
      }

      for (const scene of scenes) {
        if (scene.status === "approved") continue;
        setNotice(`Đang gửi cảnh ${scene.sceneIndex}/${scenes.length} vào Veo; cảnh sau sẽ chờ frame nối.`);
        const { job } = await requestJson<JobResponse>(`/api/scenes/${scene.id}/generate`, { method: "POST" });
        setJobs((current) => [job, ...current.filter((item) => item.sceneId !== scene.id)]);
        setScenes((current) => current.map((item) => item.id === scene.id ? { ...item, status: "queued" } : item));
        const finished = await pollJob(job.id, scene.id);
        if (!finished || finished.status !== "done") throw new Error(`Cảnh ${scene.sceneIndex} chưa hoàn tất; pipeline đã tạm dừng an toàn.`);
      }
      setNotice("Toàn bộ cảnh đã qua QC. Bạn có thể ghép video dài ngay bây giờ.");
    } catch (error) {
      setNotice(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  function simulateScene(sceneId: string) {
    const target = scenes.find((scene) => scene.id === sceneId);
    setScenes((current) => current.map((scene) => {
      if (scene.id === sceneId) return { ...scene, status: "generating" };
      if (target?.status === "approved" && scene.sceneIndex > target.sceneIndex) {
        return { ...scene, status: "waiting_previous", startFrameUri: null, endFrameUri: null, outputVideoUri: null, qualityScore: null };
      }
      return scene;
    }));
    const job = makeDemoJob(`job_${Date.now()}`, sceneId, "running", 28);
    setJobs((current) => [job, ...current.filter((item) => item.sceneId !== sceneId)]);
    setNotice("Đang mô phỏng một job Veo Lower Priority.");
    window.setTimeout(() => {
      setScenes((current) => current.map((scene) => scene.id === sceneId ? { ...scene, status: "approved", qualityScore: 94, outputVideoUri: `mock://${scene.id}.mp4` } : scene));
      setJobs((current) => current.map((item) => item.id === job.id ? { ...item, status: "done", progress: 100 } : item));
      setNotice("Mô phỏng hoàn tất: cảnh đạt QC 94/100 và đã mở khóa cảnh kế tiếp.");
    }, 900);
  }

  async function renderProject() {
    if (!renderReady) {
      setNotice("Hãy hoàn tất và duyệt tất cả cảnh trước khi ghép video dài.");
      return;
    }
    if (!signedIn || !projectId) {
      setNotice("Đã tạo render plan: 4 cảnh, 3 match-cut, video dọc 1080 × 1920, dài 30 giây.");
      return;
    }
    setBusy(true);
    try {
      const { render } = await requestJson<RenderResponse>(`/api/projects/${projectId}/render`, { method: "POST" });
      setRenderMediaUrl(render.mediaUrl ?? null);
      setNotice(
        render.status === "done"
          ? render.renderer === "mock-ffmpeg"
            ? "Renderer mock đã ghép xong video. Bản xem trước đã sẵn sàng bên dưới."
            : "FFmpeg đã ghép xong video dài và lưu đầu ra an toàn."
          : "Render plan đã được lưu; hãy cấu hình FFmpeg Cloud Run để tạo file đầu ra.",
      );
    } catch (error) {
      setNotice(readableError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar" aria-label="Điều hướng chính">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true" />
          <span><strong>SceneFlow</strong><small>AI VIDEO STUDIO</small></span>
        </div>
        <button className="new-project-button" type="button" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>
          <span aria-hidden="true">＋</span> Dự án mới
        </button>
        <nav className="side-nav">
          <p className="nav-label">Không gian làm việc</p>
          {navItems.map(([icon, label, badge]) => (
            <button className={activeNav === label ? "nav-item is-active" : "nav-item"} key={label} onClick={() => setActiveNav(label)} type="button">
              <span className="nav-icon" aria-hidden="true">{icon}</span><span>{label}</span>
              {badge ? <span className="nav-badge">{badge}</span> : null}
            </button>
          ))}
        </nav>
        <div className="side-footer">
          <div className="plan-card">
            <span className="plan-icon" aria-hidden="true">◆</span>
            <div><strong>Creator trial</strong><p>84 / 100 credit</p></div>
            <div className="mini-progress"><span /></div>
          </div>
          <div className="account-card">
            <span className="avatar">{userName.slice(0, 1).toUpperCase()}</span>
            <span><strong>{userName}</strong><small>{signedIn ? "Đã đăng nhập" : "Chế độ trải nghiệm"}</small></span>
            <span aria-hidden="true">•••</span>
          </div>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">STUDIO / DỰ ÁN ĐANG CHẠY</p><h1>Xưởng video tự động</h1></div>
          <div className="top-actions">
            <span className="system-status">Hệ thống ổn định</span>
            {!signedIn ? <a className="ghost-button" href="/signin-with-chatgpt?return_to=%2F">Đăng nhập</a> : null}
            <button className="primary-button compact" type="button" disabled={busy} onClick={runPipeline}>{busy ? "Đang chạy…" : "Chạy toàn bộ"}</button>
          </div>
        </header>

        {notice ? <div className="notice-bar" role="status"><strong>SceneFlow</strong><span>{notice}</span><button className="text-button" type="button" onClick={() => setNotice("")}>Đóng</button></div> : null}

        <section className="metrics-grid" aria-label="Tổng quan hôm nay">
          <Metric label="Dự án hôm nay" value="12" caption="+18% so với hôm qua" tone="purple" glyph="▣" />
          <Metric label="Cảnh trong hàng đợi" value={String(runningJobs)} caption="tự chạy theo thứ tự" tone="orange" glyph="↻" />
          <Metric label="Tỷ lệ đạt QC" value="91.4%" caption="7 ngày gần nhất" tone="green" glyph="✓" />
          <Metric label="Chi phí dự kiến" value="$1.62" caption="cho project 4 cảnh" tone="blue" glyph="$" />
        </section>

        <section className="creation-grid">
          <article className="panel create-panel">
            <div className="panel-heading"><div><span className="section-kicker">PHASE 01</span><h2>Tạo dự án mới</h2></div><span className="phase-chip">MVP</span></div>
            <form onSubmit={submitProject}>
              <label>Tên dự án<input value={projectName} maxLength={120} onChange={(event) => setProjectName(event.target.value)} /></label>
              <label>Ý tưởng video<textarea rows={4} value={brief} maxLength={3000} onChange={(event) => setBrief(event.target.value)} /></label>
              <div className="upload-strip">
                <label className="upload-preview product">
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setProductFile(event.target.files?.[0] ?? null)} />
                  <span className="upload-control"><strong>Ảnh sản phẩm</strong><small>{productFile?.name ?? "PNG, JPG hoặc WebP"}</small></span>
                </label>
                <label className="upload-preview person">
                  <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setCharacterFile(event.target.files?.[0] ?? null)} />
                  <span className="upload-control"><strong>Ảnh nhân vật / KOC</strong><small>{characterFile?.name ?? "Tối đa 20 MB"}</small></span>
                </label>
              </div>
              <div className="form-row three">
                <label>Template<select defaultValue="koc-product"><option value="koc-product">KOC review</option><option value="fashion">Thời trang</option><option value="faceless">Không lộ mặt</option></select></label>
                <label>Model<select value={model} onChange={(event) => setModel(event.target.value)}><option value="veo-3.1-lite">Lite — tiết kiệm</option><option value="veo-3.1-fast">Fast — cân bằng</option><option value="veo-3.1-standard">Standard</option></select></label>
                <label>Khung hình<select value={ratio} onChange={(event) => setRatio(event.target.value)}><option value="9:16">9:16 dọc</option><option value="16:9">16:9 ngang</option></select></label>
              </div>
              <div className="optimizer-box">
                <div><span className="spark" aria-hidden="true">✦</span><p><strong>Tối ưu prompt có kiểm soát</strong><small>Giữ nguyên ý chính, công khai mọi giả định.</small></p></div>
                <button className={optimized ? "toggle is-on" : "toggle"} type="button" disabled={busy} onClick={optimizePrompt} aria-label="Bật tối ưu prompt" aria-pressed={optimized} />
                {optimized && compilation ? <div className="optimized-preview"><strong>AI hiểu ý bạn</strong><p>{compilation.optimizedPromptEn}</p>{compilation.assumptions.map((item) => <small key={item}>• Giả định: {item}</small>)}{compilation.clarificationQuestions.map((item) => <small key={item}>• Cần xác nhận: {item}</small>)}</div> : null}
              </div>
              <button className="primary-button full" type="submit" disabled={busy}>{busy ? "Đang xử lý…" : "Tạo storyboard 4 cảnh"}<span aria-hidden="true">→</span></button>
            </form>
          </article>

          <article className="panel workflow-panel">
            <div className="panel-heading"><div><span className="section-kicker">PIPELINE</span><h2>Luồng sản xuất</h2></div><span><i className="live-dot" /> LIVE</span></div>
            <ol className="workflow-list">
              <WorkflowStep index="01" title="Brief & sản phẩm" caption="Khóa ảnh tham chiếu" status="done" />
              <WorkflowStep index="02" title="Prompt & Story Bible" caption="7 trường continuity" status="done" />
              <WorkflowStep index="03" title="Storyboard & keyframe" caption={`${scenes.length} cảnh • frame nối`} status="done" />
              <WorkflowStep index="04" title="Tạo video Veo" caption={`${approvedScenes}/${scenes.length} cảnh đã duyệt`} status="active" />
              <WorkflowStep index="05" title="QC & ghép video" caption={renderReady ? "Sẵn sàng render" : "Chờ các cảnh còn lại"} status={renderReady ? "done" : "waiting"} />
            </ol>
            <div className="cost-card"><div><span>Ước tính</span><strong>$1.62</strong></div><div><span>Thời lượng</span><strong>30 giây</strong></div><div><span>Dự kiến</span><strong>~18 phút</strong></div></div>
          </article>
        </section>

        <section className="panel storyboard-panel">
          <div className="storyboard-heading">
            <div><span className="section-kicker">PHASE 02–03</span><h2>Storyboard có continuity</h2><p>Frame cuối cảnh trước trở thành điểm neo cho cảnh tiếp theo.</p></div>
            <div className="storyboard-actions"><button className="ghost-button compact" type="button">Story Bible</button><button className="primary-button compact" type="button" disabled={busy} onClick={generateNext}>Tạo cảnh tiếp</button></div>
          </div>
          <div className="storyboard-track">
            {scenes.map((scene, index) => (
              <div className="scene-wrap" key={scene.id}>
                <article className="scene-card">
                  <div className={`scene-visual tone-${["one", "two", "three", "four"][index % 4]}`}>
                    <span className="scene-number">{String(scene.sceneIndex).padStart(2, "0")}</span><span className="duration-pill">{scene.durationSeconds}s</span>
                    <span className="visual-subject">{index === 3 ? "Hero frame" : "Identity locked"}</span>
                    {["queued", "generating"].includes(scene.status) ? <div className="generation-overlay"><span className="spinner" /><strong>{jobProgress(jobs, scene.id)}%</strong><small>Veo Lower Priority</small></div> : null}
                  </div>
                  <div className="scene-content">
                    <div className="scene-title-row"><h3>{scene.title}</h3><StatusPill status={scene.status} /></div>
                    <p>{scene.action}</p>
                    <div className="boundary-note"><strong>Kết cảnh:</strong> {scene.endState}</div>
                    <div className="scene-actions"><button type="button" onClick={() => setNotice(scene.prompt)}>Xem prompt</button><button type="button" disabled={busy} onClick={() => generateScene(scene.id)}>Tạo lại</button></div>
                  </div>
                </article>
                {index < scenes.length - 1 ? <span className="scene-connector" aria-label="Frame nối">→</span> : null}
              </div>
            ))}
          </div>
        </section>

        <section className="bottom-grid">
          <article className="panel queue-panel">
            <div className="panel-heading"><div><span className="section-kicker">JOBS</span><h2>Hàng đợi tạo video</h2></div><span className="phase-chip">{runningJobs} đang chạy</span></div>
            <div className="queue-table" role="table" aria-label="Hàng đợi tạo video">
              <div className="queue-head" role="row"><span>Công việc</span><span>Model</span><span>Trạng thái</span><span>Tiến độ</span></div>
              {(jobs.length ? jobs : demoJobs).slice(0, 4).map((job) => (
                <div className="queue-row" role="row" key={job.id}>
                  <span><i className="job-icon">▶</i><strong>Cảnh {sceneNumber(scenes, job.sceneId)}</strong></span><span>{modelLabel(job.model)}</span>
                  <span className={`job-state ${job.status === "done" ? "completed" : job.status === "running" ? "processing" : job.status}`}>{statusLabel(job.status)}</span>
                  <span className="progress-cell"><div><span style={{ width: `${job.progress}%` }} /></div>{job.progress}%</span>
                </div>
              ))}
            </div>
          </article>

          <article className="panel continuity-panel">
            <div className="panel-heading"><div><span className="section-kicker">CONTINUITY</span><h2>Khóa nhất quán</h2></div></div>
            <div className="score-ring"><strong>94</strong><span>/ 100</span></div>
            <div className="lock-list">
              <div><span className="lock-thumb face" /><p><strong>Nhân vật</strong><small>Khuôn mặt, tóc, trang phục</small></p><span>✓</span></div>
              <div><span className="lock-thumb cup" /><p><strong>Sản phẩm</strong><small>Tỷ lệ, màu và nhãn</small></p><span>✓</span></div>
              <div><span className="lock-thumb light" /><p><strong>Ánh sáng</strong><small>Hướng sáng và nhiệt độ màu</small></p><span>✓</span></div>
            </div>
            <div className="render-ready"><span aria-hidden="true">✓</span><span>{renderReady ? "Đủ cảnh để ghép video 30 giây" : `Còn ${scenes.length - approvedScenes} cảnh cần hoàn tất`}</span></div>
            <button className="primary-button full" type="button" disabled={busy || !renderReady} onClick={renderProject}>Ghép video dài</button>
            {renderMediaUrl ? <video className="render-preview" controls preload="metadata" src={renderMediaUrl}>Trình duyệt không hỗ trợ xem video.</video> : null}
          </article>
        </section>
      </main>
    </div>
  );
}

function Metric({ label, value, caption, tone, glyph }: { label: string; value: string; caption: string; tone: string; glyph: string }) {
  return <article className={`metric-card metric-${tone}`}><span className="metric-glyph" aria-hidden="true">{glyph}</span><p>{label}</p><strong>{value}</strong><small>{caption}</small></article>;
}

function WorkflowStep({ index, title, caption, status }: { index: string; title: string; caption: string; status: "done" | "active" | "waiting" }) {
  return <li className={`workflow-step ${status}`}><span className="step-index">{status === "done" ? "✓" : index}</span><div><strong>{title}</strong><small>{caption}</small></div><span className="step-state">{status === "done" ? "Xong" : status === "active" ? "Đang chạy" : "Chờ"}</span></li>;
}

function StatusPill({ status }: { status: Scene["status"] }) {
  const css = status === "approved" ? "completed" : status === "generating" ? "processing" : status === "waiting_previous" || status === "planned" ? "draft" : status;
  return <span className={`status-pill status-${css}`}>{sceneStatusLabel(status)}</span>;
}

function sceneStatusLabel(status: Scene["status"]): string {
  return ({ approved: "Đã duyệt", generating: "Đang tạo", queued: "Đã xếp hàng", waiting_previous: "Chờ cảnh trước", planned: "Đã lên kế hoạch", quality_check: "Đang QC", failed: "Lỗi" } as Record<Scene["status"], string>)[status];
}

function statusLabel(status: GenerationJob["status"]): string {
  return ({ queued: "Đang chờ", running: "Đang tạo", done: "Hoàn tất", failed: "Lỗi", canceled: "Đã dừng" } as Record<GenerationJob["status"], string>)[status];
}

function modelLabel(model: string): string {
  return model === "veo-3.1-standard" ? "Veo Standard" : model === "veo-3.1-fast" ? "Veo Fast" : "Veo 3.1 Lite";
}

function jobProgress(jobs: GenerationJob[], sceneId: string): number {
  return jobs.find((job) => job.sceneId === sceneId)?.progress ?? 18;
}

function sceneNumber(scenes: Scene[], sceneId: string): string {
  return String(scenes.find((scene) => scene.id === sceneId)?.sceneIndex ?? "—").padStart(2, "0");
}

async function uploadReference(projectId: string, kind: AssetKind, file: File | null) {
  if (!file) return null;
  const form = new FormData();
  form.set("projectId", projectId);
  form.set("kind", kind);
  form.set("file", file);
  return requestJson("/api/assets", { method: "POST", body: form });
}

async function requestJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as { error?: string; message?: string } & T;
  if (!response.ok) throw new Error(body.message || errorLabel(body.error) || `Yêu cầu thất bại (${response.status}).`);
  return body;
}

function errorLabel(code?: string): string | null {
  if (!code) return null;
  const labels: Record<string, string> = {
    authentication_required: "Bạn cần đăng nhập để lưu và chạy dự án.",
    previous_scene_not_approved: "Cảnh trước chưa đạt QC nên cảnh này chưa thể chạy.",
    insufficient_credits: "Tài khoản không đủ credit để tạo cảnh này.",
    scenes_not_ready: "Mọi cảnh phải hoàn tất trước khi ghép.",
    media_storage_unavailable: "Kho ảnh tham chiếu chưa sẵn sàng.",
  };
  return labels[code] ?? `Có lỗi xảy ra: ${code}`;
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : "Có lỗi xảy ra. Vui lòng thử lại.";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function makeDemoScene(index: number, title: string, action: string, endState: string, status: Scene["status"]): Scene {
  return {
    id: `scene_demo_0${index}`,
    projectId: "prj_demo",
    sceneIndex: index,
    title,
    durationSeconds: 8,
    status,
    startState: index === 1 ? "Nhân vật, sản phẩm và ánh sáng đã khóa." : "Tiếp nối chính xác frame cuối cảnh trước.",
    action,
    endState,
    prompt: `8-second cinematic shot. ${action} Preserve identity, product and lighting continuity.`,
    negativePrompt: "identity drift, product deformation, flicker, text",
    transition: index === 1 ? "hard_cut" : "match_cut",
    dependsOnSceneId: index === 1 ? null : `scene_demo_0${index - 1}`,
    startFrameUri: index === 1 ? null : `mock://frame-${index - 1}.jpg`,
    endFrameUri: status === "approved" ? `mock://frame-${index}.jpg` : null,
    outputVideoUri: status === "approved" ? `mock://scene-${index}.mp4` : null,
    qualityScore: status === "approved" ? 94 : null,
  };
}

function makeDemoJob(id: string, sceneId: string, status: GenerationJob["status"], progress: number): GenerationJob {
  const now = new Date().toISOString();
  return { id, projectId: "prj_demo", sceneId, provider: "mock", providerOperationId: id, model: "veo-3.1-lite", status, progress, attempt: 1, estimatedCostUsd: 0.4, errorCode: null, createdAt: now, updatedAt: now };
}
