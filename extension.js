import * as vscode from 'vscode';
import axios from 'axios';
import { ErrorTreeDataProvider } from './ErrorTreeDataProvider.js';
import { AIChatDataProvider } from './AIChatDataProvider.js';


const GEMINI_API_KEY = "YOUR_GEMINI_API_KEY";
const MURF_API_KEY = "YOUR_MURF_API_KEY";

export async function activate(context) {
    const errorProvider = new ErrorTreeDataProvider();
    vscode.window.createTreeView('aiErrorHelperView', { treeDataProvider: errorProvider });

    // === NEW: AI Chat tab (TreeView list) ===
    const aiChatProvider = new AIChatDataProvider();
    vscode.window.createTreeView('aiChatView', { treeDataProvider: aiChatProvider });

    // === NEW: Open Chat Panel command (rich chat UI inside panel) ===
    context.subscriptions.push(
        vscode.commands.registerCommand('ai-chat.openPanel', () => openChatPanel(context, aiChatProvider))
    );

    // === NEW: send message in chat tree ===
    context.subscriptions.push(
        vscode.commands.registerCommand('ai-chat.sendMessage', async () => {
            const userInput = await vscode.window.showInputBox({ prompt: "Ask AI something..." });
            if (!userInput) return;
            aiChatProvider.addMessage("user", userInput);
            try {
                const res = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
                    { contents: [{ parts: [{ text: userInput }] }] },
                    { headers: { "Content-Type": "application/json" } }
                );
                const reply = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No response.";
                aiChatProvider.addMessage("ai", reply);
            } catch (err) {
                console.error("AI Chat Error:", err.response?.data || err.message);
                aiChatProvider.addMessage("ai", "❌ Failed to fetch AI reply.");
            }
        })
    );

    const updateSidebar = () => {
        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            errorProvider.refresh([]);
            return;
        }

        const diagnostics = vscode.languages.getDiagnostics(activeEditor.document.uri)
            .filter(d => d.severity === vscode.DiagnosticSeverity.Error);

        const existingSolutions = new Map();
        for (const error of errorProvider.errors) {
            if (error.solution) {
                const errorKey = `${error.diagnostic.message}|${error.diagnostic.range.start.line}`;
                existingSolutions.set(errorKey, error.solution);
            }
        }

        const newErrorInfos = diagnostics.map(diagnostic => {
            const errorKey = `${diagnostic.message}|${diagnostic.range.start.line}`;
            return {
                diagnostic,
                document: activeEditor.document,
                solution: existingSolutions.get(errorKey) || null
            };
        });

        errorProvider.refresh(newErrorInfos);
    };

    context.subscriptions.push(
        vscode.languages.onDidChangeDiagnostics(updateSidebar),
        vscode.window.onDidChangeActiveTextEditor(updateSidebar)
    );

    updateSidebar();

    // === COMMAND 1: Get AI Explanation (unchanged) ===
    const disposableGetExplanation = vscode.commands.registerCommand('ai-error-helper.getExplanation', async (errorInfo) => {
        if (!errorInfo) return;

        const errorKey = `${errorInfo.diagnostic.message}|${errorInfo.diagnostic.range.start.line}`;
        const errorToUpdate = errorProvider.errors.find(
            e => `${e.diagnostic.message}|${e.diagnostic.range.start.line}` === errorKey
        );

        if (!errorToUpdate) return;

        errorToUpdate.solution = "⏳ Explanation loading..., please wait a moment...";
        errorProvider.refresh(errorProvider.errors);

        try {
            const { diagnostic, document } = errorInfo;
            const codeLine = document.lineAt(diagnostic.range.start.line).text;

            const prompt = `Explain this error to me like a good friend like a story, in about 1000 - 1100 letters, so I can quickly understand it:
            Error: "${diagnostic.message}" 
            Code line: "${codeLine}"`;

            const geminiRes = await axios.post(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
                { contents: [{ parts: [{ text: prompt }] }] },
                { headers: { "Content-Type": "application/json" } }
            );

            let solutionText =
                geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
                "💡 AI Solution unavailable.";

            // clean markdown
            solutionText = solutionText
                .replace(/```[a-z]*\n([\s\S]*?)```/gi, '$1')
                .replace(/\*\*(.*?)\*\*/g, '$1')
                .replace(/__(.*?)__/g, '$1')
                .replace(/`(.*?)`/g, '$1')
                .replace(/\bc\+\+\b/gi, '');

            errorToUpdate.solution = solutionText;
            errorProvider.refresh(errorProvider.errors);

            vscode.commands.executeCommand('ai-error-helper.showSolutionWebview', solutionText);
        } catch (err) {
            console.error("Failed to get AI solution:", err.response?.data || err.message);
            errorToUpdate.solution = "❌ Failed to get AI solution. Check Debug Console.";
            errorProvider.refresh(errorProvider.errors);
        }
    });

    
    const disposablePlayVoiceExplanation = vscode.commands.registerCommand(
        'ai-error-helper.playVoiceExplanation',
        async (errorInfo) => {
            if (!errorInfo) return;

            try {
                const { diagnostic, document } = errorInfo;
                const codeLine = document.lineAt(diagnostic.range.start.line).text;

                const prompt = `Explain this error in simple friendly words like a short story so I can quickly understand:
Error: "${diagnostic.message}"
Code line: "${codeLine}"`;

                const geminiRes = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
                    { contents: [{ parts: [{ text: prompt }] }] },
                    { headers: { "Content-Type": "application/json" } }
                );

                let solutionText = geminiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || "No explanation available.";
                // clean markdown for TTS
                solutionText = solutionText
                    .replace(/```[a-z]*\n([\s\S]*?)```/gi, '$1')
                    .replace(/\*\*(.*?)\*\*/g, '$1')
                    .replace(/__(.*?)__/g, '$1')
                    .replace(/`(.*?)`/g, '$1');

                // Murf TTS (plays without opening your solution webview)
                vscode.window.setStatusBarMessage("🔊 Generating voice explanation...", 2000);
                const ttsRes = await axios.post(
                    "https://api.murf.ai/v1/speech/generate",
                    {
                        text: solutionText,
                        voice_id: "en-US-natalie",
                        style: "Promo"
                    },
                    {
                        headers: {
                            "Content-Type": "application/json",
                            Accept: "application/json",
                            "api-key": MURF_API_KEY
                        }
                    }
                );

                const audioUrl = ttsRes.data?.audioFile || ttsRes.data?.audio_url;
                if (audioUrl) {
                    // Open externally so we don't change VS Code tab/webview
                    vscode.env.openExternal(vscode.Uri.parse(audioUrl));
                } else {
                    vscode.window.showErrorMessage("❌ Failed to fetch audio URL from Murf.");
                    console.error("Murf response without audio URL:", ttsRes.data);
                }
            } catch (err) {
                console.error("Voice Explanation Error:", err.response?.data || err.message);
                vscode.window.showErrorMessage("❌ Failed to generate voice explanation.");
            }
        }
    );

    // === Command to show solution in webview & TTS (UNCHANGED style) ===
    const disposableShowWebview = vscode.commands.registerCommand(
        'ai-error-helper.showSolutionWebview',
        (solution, errorMessage) => {
            const tabTitle = errorMessage ? `Error: ${errorMessage.substring(0, 50)}` : 'Error';

            const escapeHtml = (unsafe) => unsafe
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#039;");

            const solutionForHtmlDisplay = escapeHtml(solution);
            const solutionForTTS = JSON.stringify(solution);

            const panel = vscode.window.createWebviewPanel(
                'aiSolution',
                tabTitle,
                vscode.ViewColumn.One, {
                enableScripts: true,
                retainContextWhenHidden: true
            }
            );

            panel.webview.html = `
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(tabTitle)}</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet">
<style>
    body {
        font-family: 'Poppins', sans-serif;
        padding: 40px;
        margin: 0;
        background: linear-gradient(135deg, #0d0d10, #1a1a1f);
        color: #e4e6eb;
        line-height: 1.8;
        display: flex;
        justify-content: center;
    }
    .container {
        max-width: 900px;
        width: 100%;
        max-height: 70vh;
        overflow-y: auto;
        padding: 28px 32px;
        background: rgba(255, 255, 255, 0.03);
        border-radius: 16px;
        backdrop-filter: blur(10px);
        box-shadow: 0 6px 20px rgba(0,0,0,0.6);
        margin-bottom: 28px;
        white-space: pre-wrap;
        word-wrap: break-word;
        font-size: 15px;
        border: 1px solid rgba(255,255,255,0.08);
    }
    h1, h2, h3 {
        color: #4dabf7;
        margin-bottom: 14px;
        font-weight: 600;
    }
    button {
        padding: 12px 24px;
        font-size: 15px;
        font-weight: 500;
        border: none;
        border-radius: 10px;
        background: linear-gradient(135deg, #4dabf7, #1864ab);
        color: #fff;
        cursor: pointer;
        transition: all 0.25s ease;
        box-shadow: 0 4px 14px rgba(0,0,0,0.3);
        margin-top: 8px;
    }
    button:hover {
        transform: translateY(-2px);
        box-shadow: 0 6px 18px rgba(0,0,0,0.5);
        background: linear-gradient(135deg, #5cb6ff, #1a6fc2);
    }
    #audio-player-container {
        margin-top: 22px;
        display: flex;
        justify-content: center;
        width: 100%;
    }
    audio {
        width: 100%;
        max-width: 680px;
        height: 50px;
        border-radius: 12px;
        background: #141418;
        box-shadow: 0 4px 14px rgba(0,0,0,0.4), inset 0 0 6px rgba(255,255,255,0.05);
        outline: none;
        overflow: hidden;
        -webkit-appearance: none;
        -moz-appearance: none;
        appearance: none;
    }
    audio::-webkit-media-controls-panel {
        background: #141418;
        border-radius: 12px;
    }
    audio::-webkit-media-controls-play-button,
    audio::-webkit-media-controls-mute-button {
        filter: invert(90%) hue-rotate(180deg);
    }
    audio::-webkit-media-controls-timeline,
    audio::-webkit-media-controls-current-time-display,
    audio::-webkit-media-controls-time-remaining-display,
    audio::-webkit-media-controls-volume-slider {
        filter: invert(80%) hue-rotate(180deg);
    }
    .container::-webkit-scrollbar { width: 8px; }
    .container::-webkit-scrollbar-thumb { background: #3b82f6; border-radius: 6px; }
    .container::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); }
</style>
</head>
<body>
<div>
    <div class="container">${solutionForHtmlDisplay}</div>
    <button id="speakBtn">🔊 Explain in Voice</button>
    <div id="audio-player-container"></div>
</div>
<script>
    const vscode = acquireVsCodeApi();
    const speakBtn = document.getElementById('speakBtn');
    const textToSpeak = ${solutionForTTS};

    speakBtn.addEventListener('click', () => {
        speakBtn.innerText = '🔊 Generating...';
        speakBtn.disabled = true;
        document.getElementById('audio-player-container').innerHTML = '';
        vscode.postMessage({ command: 'speak', text: textToSpeak });
    });

    window.addEventListener('message', event => {
        const message = event.data;
        switch (message.command) {
            case 'speechFinished':
                speakBtn.innerText = '🔊 Explain in Voice';
                speakBtn.disabled = false;
                break;
            case 'playAudio':
                const playerContainer = document.getElementById('audio-player-container');
                const audioPlayer = document.createElement('audio');
                audioPlayer.src = message.url;
                audioPlayer.controls = true;
                audioPlayer.autoplay = true;
                playerContainer.appendChild(audioPlayer);
                break;
        }
    });
</script>
</body>
</html>
`;

            panel.webview.onDidReceiveMessage(async (message) => {
                if (message.command === 'speak' && message.text) {
                    try {
                        vscode.window.showInformationMessage("Generating audio...");

                        const response = await axios.post(
                            "https://api.murf.ai/v1/speech/generate", {
                            text: message.text,
                            voice_id: "en-US-natalie",
                            style: "Promo"
                        }, {
                            headers: {
                                "Content-Type": "application/json",
                                "Accept": "application/json",
                                "api-key": MURF_API_KEY
                            }
                        });

                        const audioUrl = response.data?.audioFile;
                        if (!audioUrl) {
                            console.error("Full response from Murf:", JSON.stringify(response.data, null, 2));
                            throw new Error("Murf API response did not contain an 'audioFile' key.");
                        }

                        panel.webview.postMessage({ command: 'playAudio', url: audioUrl });
                    } catch (err) {
                        console.error("Murf TTS Error:", err.response?.data || err.message);
                        vscode.window.showErrorMessage("Failed to play TTS. Check the Debug Console for details.");
                    } finally {
                        panel.webview.postMessage({ command: 'speechFinished' });
                    }
                }
            });
        }
    );

    context.subscriptions.push(
        disposableGetExplanation,
        disposablePlayVoiceExplanation,
        disposableShowWebview
    );
}

export function openChatPanel(context, aiChatProvider) {
    const panel = vscode.window.createWebviewPanel(
        "aiChatPanel",
        "AI Chat (Gemini)",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = getChatHtml();

    // Handle chat events from webview
    panel.webview.onDidReceiveMessage(async (message) => {
        if (message.command === "chat:send") {
            const text = `${message.text || ""}`.trim();
            if (!text) return;

            aiChatProvider.addMessage("user", text);

            try {
                // Gemini API call
                const res = await axios.post(
                    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
                    { contents: [{ parts: [{ text }] }] },
                    { headers: { "Content-Type": "application/json" } }
                );

                const reply =
                    res.data?.candidates?.[0]?.content?.parts?.[0]?.text ||
                    "No response.";
                aiChatProvider.addMessage("ai", reply);

                // Send AI response to WebView
                panel.webview.postMessage({
                    command: "chat:append",
                    role: "ai",
                    text: reply,
                });
            } catch (e) {
                const errText = "❌ Failed to fetch AI reply.";
                console.error("AI Chat Panel Error:", e.response?.data || e.message);
                aiChatProvider.addMessage("ai", errText);
                panel.webview.postMessage({
                    command: "chat:append",
                    role: "ai",
                    text: errText,
                });
            }
        }

        // Murf TTS request
        if (message.command === "chat:tts") {
            try {
                const res = await axios.post(
                    "https://api.murf.ai/v1/speech/generate",
                    {
                        text: message.text,
                        voice_id: "en-US-natalie",
                        style: "Promo",
                    },
                    {
                        headers: {
                            "Content-Type": "application/json",
                            Accept: "application/json",
                            "api-key": MURF_API_KEY,
                        },
                    }
                );

                const audioUrl = res.data?.audioFile || res.data?.audio_url;
                if (audioUrl) {
                    panel.webview.postMessage({
                        command: "chat:playAudio",
                        url: audioUrl,
                    });
                } else {
                    console.error("No audio URL in Murf response:", res.data);
                }
            } catch (err) {
                console.error("Murf TTS Error:", err.response?.data || err.message);
            }
        }
    });
}

// NOTE: getChatHtml must exist somewhere in your project.
// If it's in another file, keep it as-is. If not, add your implementation.

function getChatHtml() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root {
    --bg: #0d0f14;
    --chat-bg: #181a20;
    --user-bg: #0b74ff;
    --user-color: #fff;
    --ai-bg: #2c2f38;
    --ai-color: #e6edf3;
    --input-bg: #1f2128;
    --input-border: #444c5c;
}
* { box-sizing: border-box; margin:0; padding:0; }
body {
    font-family: 'Poppins', sans-serif;
    height: 100vh;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    padding: 20px;
}
#chat {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
    display: flex;
    flex-direction: column;
    gap: 16px;
    scroll-behavior: smooth;
    background: var(--chat-bg);
    border-radius: 24px;
    margin: 0 10px 16px 10px;
    box-shadow: inset 0 0 15px rgba(0,0,0,0.5);
}
.row { display: flex; flex-direction: column; }
.msg {
    max-width: 75%;
    padding: 14px 18px;
    border-radius: 20px;
    line-height: 1.5;
    word-wrap: break-word;
    box-shadow: 0 4px 14px rgba(0,0,0,0.5);
    margin: 2px 0;
}
.user { 
    align-self: flex-end;
    background: var(--user-bg); 
    color: var(--user-color); 
    border-bottom-right-radius: 6px;
}
.ai { 
    align-self: flex-start; 
    background: var(--ai-bg); 
    color: var(--ai-color); 
    border-bottom-left-radius: 6px;
}
.meta { 
    font-size: 12px; 
    margin-bottom: 6px; 
    opacity: 0.75; 
}
pre {
    margin: 0;
    font-family: monospace;
    white-space: pre-wrap;
}
.read-btn {
    margin-top: 8px;
    font-size: 13px;
    cursor: pointer;
    color: #0b74ff;
    text-decoration: underline;
    transition: color 0.2s ease;
}
.read-btn:hover { color: #3399ff; }
#composer {
    display: flex;
    padding: 12px 16px;
    gap: 10px;
    background: var(--chat-bg);
    border-radius: 20px;
    margin: 0 10px 10px 10px;
    align-items: center;
    box-shadow: 0 6px 16px rgba(0,0,0,0.4);
}
#input {
    flex: 1;
    border-radius: 16px;
    padding: 10px 14px;
    border: 1px solid var(--input-border);
    outline: none;
    font-family: 'Poppins', sans-serif;
    resize: vertical;
    max-height: 120px;
    background: var(--input-bg);
    color: #e6edf3;
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
#input:focus { 
    border-color: var(--user-bg); 
    box-shadow: 0 0 6px rgba(11,116,255,0.4); 
}
button {
    padding: 0 18px;
    height: 42px;
    border-radius: 9999px;
    border: none;
    background: var(--user-bg);
    color: var(--user-color);
    cursor: pointer;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform 0.2s ease, background 0.2s ease;
}
button:hover { 
    background: #005ecb; 
    transform: translateY(-2px) scale(1.05); 
}
</style>
</head>
<body>
<div id="chat"></div>
<div id="composer">
    <textarea id="input" placeholder="Type or paste code…"></textarea>
    <button id="send">
        <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" 
        viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" 
        stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13"></line>
            <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
        </svg>
    </button>
</div>
<audio id="player" controls style="display:none;"></audio>
<script>
const vscode = acquireVsCodeApi();
const chat = document.getElementById('chat');
const input = document.getElementById('input');
const sendBtn = document.getElementById('send');
const player = document.getElementById('player');

function append(role, text, typing=false) {
    const row = document.createElement('div');
    row.className = 'row';

    const bubble = document.createElement('div');
    bubble.className = 'msg ' + (role==='user' ? 'user' : 'ai');

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent = role==='user' ? '🧑 You' : '🤖 Gemini';

    const body = document.createElement('div');
    const pre = document.createElement('pre');
    body.appendChild(pre);
    bubble.appendChild(meta);
    bubble.appendChild(body);

    if(role === 'ai'){
        const readBtn = document.createElement('div');
        readBtn.className = 'read-btn';
        readBtn.textContent = '🔊 Read';
        readBtn.addEventListener('click', ()=> {
            vscode.postMessage({command:'chat:tts', text});
        });
        bubble.appendChild(readBtn);
    }

    row.appendChild(bubble);
    chat.appendChild(row);
    chat.scrollTop = chat.scrollHeight;

    if(typing && role==='ai') {
        typeWriter(pre, text);
    } else {
        pre.textContent = text;
    }
}

function typeWriter(element, text, i=0) {
    if(i===0){ element.textContent=''; }
    if(i<text.length){
        setTimeout(() => {
            element.textContent+=text.charAt(i);
            typeWriter(element, text, i+1);
            chat.scrollTop = chat.scrollHeight;
        }, 20);
    }
}

// Enter to send
input.addEventListener('keydown', e=>{
    if(e.key==='Enter' && !e.shiftKey){
        e.preventDefault();
        sendMessage();
    }
});
sendBtn.addEventListener('click', sendMessage);

function sendMessage(){
    const text=input.value.trim();
    if(!text) return;
    vscode.postMessage({command:'chat:send', text});
    append('user', text);
    input.value='';
}

window.addEventListener('message', e=>{
    const {command} = e.data||{};
    if(command==='chat:append'){
        append(e.data.role, e.data.text, e.data.role==='ai');
    }
    if(command==='chat:playAudio'){
        player.src = e.data.url;
        player.play();
    }
});
</script>
</body>
</html>`;
}

export function deactivate() { }
