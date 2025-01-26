/**
 * API 요청 재시도 함수 (Rate Limit 및 네트워크 오류 대응)
 * @param {string} url - 요청 URL
 * @param {Object} options - fetch 옵션
 * @param {number} retries - 최대 재시도 횟수 (기본값 3)
 */
async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        console.log(`[${new Date().toISOString()}] 요청 시도: ${url} (${i + 1}/${retries})`);
        const response = await fetch(url, options);
        
        if (response.ok) {
            console.log(`[${new Date().toISOString()}] 요청 성공: ${url}`);
            return response;
        }

        // Rate Limit 처리
        if (response.status === 403 && response.headers.get('X-RateLimit-Remaining') === '0') {
            const resetTime = parseInt(response.headers.get('X-RateLimit-Reset')) * 1000;
            const waitTime = resetTime - Date.now() + 1000;
            console.log(`[${new Date().toISOString()}] Rate Limit 초과. ${Math.ceil(waitTime / 1000)}초 후 재시도`);
            await new Promise(resolve => setTimeout(resolve, waitTime));
            continue;
        }
        
        console.error(`[${new Date().toISOString()}] 요청 실패: ${response.statusText}`);
        throw new Error(`Request failed: ${response.statusText}`);
    }
    throw new Error('Max retries exceeded');
}

/**
 * 개발자 목록 조회 함수
 * @returns {Promise<Array>} 개발자 정보 배열
 */
async function fetchDevelopers() {
    console.log(`[${new Date().toISOString()}] 개발자 목록 조회 시작`);
    const token = process.env.GH_TOKEN;
    const owner = process.env.TARGET_OWNER;
    const repo = process.env.TARGET_REPO;
    
    const response = await fetchWithRetry(
        `https://api.github.com/repos/${owner}/${repo}/contributors`,
        { headers: { 
            Authorization: `Bearer ${token}`, 
            Accept: "application/vnd.github.v3+json" 
        }}
    );
    
    const developers = await response.json();
    console.log(`[${new Date().toISOString()}] 개발자 목록 조회 완료 (${developers.length}명)`);
    return developers;
}

/**
 * 개발자 활동 이력 조회
 * @param {string} username - GitHub 사용자명
 * @returns {Promise<Array>} 활동 이벤트 배열
 */
async function fetchDeveloperActivity(username) {
    console.log(`[${new Date().toISOString()}] ${username} 활동 조회 시작`);
    const token = process.env.GH_TOKEN;
    const response = await fetchWithRetry(
        `https://api.github.com/users/${username}/events`,
        { headers: { 
            Authorization: `Bearer ${token}`, 
            Accept: "application/vnd.github.v3+json" 
        }}
    );
    
    const events = await response.json();
    console.log(`[${new Date().toISOString()}] ${username} 활동 조회 완료 (${events.length}개 이벤트)`);
    return events;
}

/**
 * 금일 성장 활동 여부 확인
 * @param {Array} events - GitHub 이벤트 배열
 * @returns {boolean} 활동 여부
 */
function hasGrowthActivityToday(events) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
    const hasActivity = events.some(event => {
        const eventDate = new Date(event.created_at).toLocaleDateString('en-CA', { timeZone: 'Asia/Seoul' });
        return event.type === "PushEvent" && eventDate === today;
    });
    console.log(`[${new Date().toISOString()}] 활동 여부: ${hasActivity ? '있음' : '없음'}`);
    return hasActivity;
}

/**
 * 성장 활동 리포트 생성
 * @returns {Promise<string>} 마크다운 형식 리포트
 */
async function generateGrowthReport() {
    try {
        console.log(`[${new Date().toISOString()}] 리포트 생성 시작`);
        const developers = await fetchDevelopers();
        let activeCount = 0;
        const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        let report = `## 🌱 ${now} 성장 활동 현황\n\n`;

        // 개발자별 활동 분석
        for (const dev of developers) {
            try {
                const events = await fetchDeveloperActivity(dev.login);
                const isActive = hasGrowthActivityToday(events);
                if (isActive) activeCount++;
                report += `- ${isActive ? '🫠 **' : '🤫 '}[${dev.login}](https://github.com/${dev.login})${isActive ? '** ' : ' '}\n`;
            } catch (error) {
                console.error(`[${new Date().toISOString()}] ${dev.login} 처리 실패:`, error);
                report += `- 🫥 [${dev.login}](https://github.com/${dev.login}) (일시적 오류)\n`;
            }
        }

        // 참여율 계산
        const participationRate = ((activeCount / developers.length) * 100).toFixed(2);
        report += `\n### 📊 참여율: ${participationRate}% (${activeCount}/${developers.length}명)`;
        console.log(`[${new Date().toISOString()}] 리포트 생성 완료`);
        return report;

    } catch (error) {
        console.error(`[${new Date().toISOString()}] 리포트 생성 오류:`, error);
        return "⚠️ 시스템 점검 중입니다. 30분 후 다시 시도해주세요.";
    }
}

/**
 * GitHub 이슈 생성 함수
 */
async function createGrowthReportIssue() {
    try {
        console.log(`[${new Date().toISOString()}] 이슈 생성 시작`);
        const token = process.env.GH_TOKEN;
        const OWNER = process.env.ISSUE_OWNER;
        const REPO = process.env.ISSUE_REPO;
        
        // 이슈 메타데이터 생성
        const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
        const title = `🌿 ${now} 성장 활동 리포트`;
        const body = await generateGrowthReport();
        
        // API 요청
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

// 메인 실행
createGrowthReportIssue();