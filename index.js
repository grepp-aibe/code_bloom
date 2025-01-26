/**
 * API 요청 재시도 함수 (Rate Limit 및 네트워크 오류 대응)
 * @param {string} url - 요청 대상 URL
 * @param {Object} options - fetch 함수에 전달할 옵션
 * @param {number} retries - 최대 재시도 횟수 (기본값: 3)
 *
 * [상세 설명]
 * - GitHub API 호출 시, 레이트 리밋(Rate Limit) 제한 혹은 일시적 네트워크 오류 등으로 인해
 *   요청이 실패할 수 있음.
 * - 이 함수를 사용하면, 요청이 실패했을 때 최대 `retries` 횟수만큼 재시도하도록 함.
 * - 레이트 리밋이 초과되는 경우, X-RateLimit-Reset 헤더에 따라 일정 시간 대기 후 재시도.
 * - 네트워크 또는 서버 오류(예: 500등) 시, 즉시 throw로 에러를 발생시키기보다는
 *   재시도 로직을 수행함.
 */
async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        console.log(`[${new Date().toISOString()}] 요청 시도: ${url} (${i + 1}/${retries})`);
        const response = await fetch(url, options);

        // 응답이 2xx 계열(OK)이면 즉시 반환
        if (response.ok) {
            console.log(`[${new Date().toISOString()}] 요청 성공: ${url}`);
            return response;
        }

        // Rate Limit 초과 여부 판단 (403 & X-RateLimit-Remaining이 0)
        if (response.status === 403 && response.headers.get('X-RateLimit-Remaining') === '0') {
            // X-RateLimit-Reset: 재시도가 가능한 유닉스 타임스탬프(초 단위)
            const resetTime = parseInt(response.headers.get('X-RateLimit-Reset')) * 1000;
            // 현재 시각과 resetTime의 차이 + 안전 마진(1초)
            const waitTime = resetTime - Date.now() + 1000;
            console.log(`[${new Date().toISOString()}] Rate Limit 초과. ${Math.ceil(waitTime / 1000)}초 후 재시도`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue; // 재시도 로직으로 이동
        }

        // 그 외 응답 오류(4xx, 5xx 등)
        console.error(`[${new Date().toISOString()}] 요청 실패: ${response.statusText}`);
        throw new Error(`Request failed: ${response.statusText}`);
    }
    // 모든 재시도가 실패할 경우
    throw new Error('Max retries exceeded');
}

/**
 * 개발자 목록(컨트리뷰터) 조회 함수 (페이징 처리)
 * @returns {Promise<Array>} - 개발자 정보 배열
 *
 * [상세 설명]
 * - GitHub Repo의 Contributors API를 호출해, 레포지토리에 기여한 모든 사용자 목록을 수집.
 * - 1페이지당 100명씩 조회하고, 더 이상 데이터가 없을 때까지(page 증가) 반복 호출.
 * - env에 설정된 GH_TOKEN(권한 토큰), TARGET_OWNER(조직/사용자), TARGET_REPO(레포명) 사용.
 */
async function fetchDevelopers() {
    console.log(`[${new Date().toISOString()}] 개발자 목록 조회 시작`);
    const token = process.env.GH_TOKEN;
    const owner = process.env.TARGET_OWNER;
    const repo = process.env.TARGET_REPO;

    let developers = [];
    let page = 1;
    const perPage = 100;

    // contributors API는 페이지네이션 지원
    while (true) {
        console.log(`[${new Date().toISOString()}] 페이지 ${page} 조회 중`);
        const response = await fetchWithRetry(
            `https://api.github.com/repos/${owner}/${repo}/contributors?page=${page}&per_page=${perPage}`,
            {
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github.v3+json"
                }
            }
        );

        const data = await response.json();
        // 더 이상 데이터가 없으면 배열이 빈 상태로 옴
        if (data.length === 0) break;

        // 새로운 페이지의 기여자를 합침
        developers = developers.concat(data);
        console.log(`[${new Date().toISOString()}] 페이지 ${page} 조회 완료 (현재 ${developers.length}명)`);
        page++;
    }

    console.log(`[${new Date().toISOString()}] 개발자 목록 조회 완료 (총 ${developers.length}명)`);
    return developers;
}

/**
 * 특정 개발자의 최근 활동 이력(이벤트) 조회
 * @param {string} username - GitHub 사용자명(로그인 ID)
 * @returns {Promise<Array>} - 활동 이벤트(푸시, 이슈, PR 등) 배열
 *
 * [상세 설명]
 * - GitHub의 Users Events API(`GET /users/{username}/events`)를 호출해 최근 이벤트 목록 조회.
 * - 단일 사용자가 여러 레포지토리에 푸시/이슈/PR 등 활동한 기록이 담겨 있음.
 * - env의 GH_TOKEN을 사용하여 인증. 403 RateLimit 등에 대비하여 fetchWithRetry로 감싸둠.
 */
async function fetchDeveloperActivity(username) {
    console.log(`[${new Date().toISOString()}] ${username} 활동 조회 시작`);
    const token = process.env.GH_TOKEN;
    const response = await fetchWithRetry(
        `https://api.github.com/users/${username}/events`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github.v3+json"
            }
        }
    );

    const events = await response.json();
    console.log(`[${new Date().toISOString()}] ${username} 활동 조회 완료 (${events.length}개 이벤트)`);
    return events;
}

/**
 * 금일(한국 시간 기준) 성장 활동 여부 확인
 * @param {Array} events - GitHub 이벤트 배열 (fetchDeveloperActivity의 결과)
 * @returns {boolean} - 오늘 활동이 있으면 true, 없으면 false
 *
 * [상세 설명]
 * - "오늘"은 서울(Asia/Seoul) 타임존 기준으로 날짜가 같은지를 본다.
 * - 이벤트 중 PushEvent 혹은 CreateEvent가 오늘 발생했는지 체크.
 */
function hasGrowthActivityToday(events) {
    // 1) 한국 시각으로 "현재 시각"을 구하고, 날짜 부분만 잘라 "오늘 00:00" 시점 생성
    const nowSeoulString = new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' });
    const nowSeoulDate = new Date(nowSeoulString);
    const todaySeoul = new Date(
        nowSeoulDate.getFullYear(),
        nowSeoulDate.getMonth(),
        nowSeoulDate.getDate()
    );

    // 2) 이벤트 배열 중, 다음 조건을 만족하는 이벤트가 하나라도 있는지 검사
    //   (1) event.type이 "PushEvent" 또는 "CreateEvent"
    //   (2) created_at을 서울 시각으로 변환했을 때, 날짜가 오늘(todaySeoul)과 동일
    const hasActivity = events.some(event => {
        // 푸시 or 레포/브랜치 생성(CreateEvent)만 추적
        if (event.type !== "PushEvent" && event.type !== "CreateEvent") {
            return false;
        }

        // created_at(UTC)을 한국 시간으로 변환
        const eventUTC = new Date(event.created_at);
        const eventSeoulString = eventUTC.toLocaleString('en-US', { timeZone: 'Asia/Seoul' });
        const eventSeoulDate = new Date(eventSeoulString);

        // 이벤트 발생 날짜(년/월/일만)와 오늘 날짜가 같은지 비교
        const eventDaySeoul = new Date(
            eventSeoulDate.getFullYear(),
            eventSeoulDate.getMonth(),
            eventSeoulDate.getDate()
        );

        return eventDaySeoul.getTime() === todaySeoul.getTime();
    });

    console.log(`[${new Date().toISOString()}] 활동 여부: ${hasActivity ? '있음' : '없음'}`);
    return hasActivity;
}

/**
 * 전체 개발자의 '금일 성장 활동' 리포트를 생성(마크다운 포맷)
 * @returns {Promise<string>} - 생성된 리포트를 마크다운 형태로 반환
 *
 * [상세 설명]
 * - 개발자 목록을 조회한 뒤, 각 개발자별 이벤트를 조회하여 hasGrowthActivityToday()로 체크.
 * - 참여율 = (오늘 활동한 사람 수) / (전체 개발자 수) * 100%
 * - 보고서에 각 개발자의 GitHub 링크를 표시, 활동자가 많으면 🫠로, 없으면 🤫로 표시.
 * - 어느 개발자 조회에서 오류 발생 시, 해당 사용자는 "(일시적 오류)" 메시지를 표시.
 */
async function generateGrowthReport() {
    try {
        console.log(`[${new Date().toISOString()}] 리포트 생성 시작`);
        // 1) 전체 기여자 목록 조회
        const developers = await fetchDevelopers();
        let activeCount = 0;

        // 보고서 시작 부분: 현재 시각(한국 기준) + 타이틀
        const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        let report = `## 🌱 ${now} 성장 활동 현황\n\n`;

        // 2) 각 개발자별로 이벤트 받아와서 오늘 활동 체크
        for (const dev of developers) {
            try {
                const events = await fetchDeveloperActivity(dev.login);
                const isActive = hasGrowthActivityToday(events);
                if (isActive) activeCount++;
                report += `- ${isActive ? '🫠 **' : '🤫 '}[${dev.login}](https://github.com/${dev.login})${isActive ? '** ' : ' '}\n`;
            } catch (error) {
                // 이벤트 조회 실패 시
                console.error(`[${new Date().toISOString()}] ${dev.login} 처리 실패:`, error);
                report += `- 🫥 [${dev.login}](https://github.com/${dev.login}) (일시적 오류)\n`;
            }
        }

        // 3) 참여율(소수점 2자리)
        const participationRate = ((activeCount / developers.length) * 100).toFixed(2);
        report += `\n### 📊 참여율: ${participationRate}% (${activeCount}/${developers.length}명)`;
        console.log(`[${new Date().toISOString()}] 리포트 생성 완료`);
        return report;

    } catch (error) {
        // 만약 전체 과정에서 오류가 나면, 에러 표시 메시지로 대체
        console.error(`[${new Date().toISOString()}] 리포트 생성 오류:`, error);
        return "⚠️ 시스템 점검 중입니다. 30분 후 다시 시도해주세요.";
    }
}

/**
 * GitHub 이슈 생성 함수
 * @description 리포트 내용을 GitHub 이슈로 생성
 *
 * [상세 설명]
 * - env에 ISSUE_OWNER, ISSUE_REPO, GH_TOKEN이 정의되어 있어야 함.
 * - 위에서 generateGrowthReport()로 만든 리포트를 Issue 본문(body)에 담아 생성.
 * - Issue 생성 API: POST /repos/{owner}/{repo}/issues
 * - 생성이 성공하면 콘솔에 "✅ 이슈 생성 성공", 실패 시 "❌ 이슈 생성 실패" 메시지 로깅.
 */
async function createGrowthReportIssue() {
    try {
        console.log(`[${new Date().toISOString()}] 이슈 생성 시작`);
        const token = process.env.GH_TOKEN;
        const OWNER = process.env.ISSUE_OWNER;
        const REPO = process.env.ISSUE_REPO;

        // 이슈 제목: 현재 시각 + "성장 활동 리포트"
        const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        const title = `🌿 ${now} 성장 활동 리포트`;
        const body = await generateGrowthReport();

        // fetchWithRetry 사용해 안전하게 이슈 생성 요청
        const response = await fetchWithRetry(
            `https://api.github.com/repos/${OWNER}/${REPO}/issues`,
            {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    Accept: "application/vnd.github.v3+json",
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({ title, body }),
            }
        );

        console.log(`[${new Date().toISOString()}] 이슈 생성 응답: ${response.status}`);
        if (response.ok) {
            console.log("✅ 이슈 생성 성공");
        } else {
            console.error("❌ 이슈 생성 실패:", await response.text());
        }
    } catch (error) {
        console.error(`[${new Date().toISOString()}] 이슈 생성 실패:`, error);
    }
}

// 메인 실행: 스크립트가 실행될 때 바로 createGrowthReportIssue()를 호출
createGrowthReportIssue();
