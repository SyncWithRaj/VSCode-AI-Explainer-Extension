import * as vscode from 'vscode';
import axios from 'axios';
import { ErrorTreeDataProvider } from './ErrorTreeDataProvider.js';
import { AIChatDataProvider } from './AIChatDataProvider.js'; // NEW

// API keys (replace with your .env keys if needed)
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

    // NEW: command to send a chat message to AI (updates AI Chat tree view)
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

    // Command to get AI explanation
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

            // REMOVE markdown formatting like **bold**, __underline__, and ```c++``` code blocks
            solutionText = solutionText
                .replace(/```[a-z]*\n([\s\S]*?)```/gi, '$1')  // remove code block markers and language (like ```c++)
                .replace(/\*\*(.*?)\*\*/g, '$1')               // remove bold **
                .replace(/__(.*?)__/g, '$1')                   // remove underline __
                .replace(/`(.*?)`/g, '$1')                     // remove inline code ``
                .replace(/\bc\+\+\b/gi, '');                   // remove standalone 'c++' mentions

            errorToUpdate.solution = solutionText;
            errorProvider.refresh(errorProvider.errors);
            vscode.commands.executeCommand('ai-error-helper.showSolutionWebview', solutionText);

        } catch (err) {
            console.error("Failed to get AI solution:", err.response?.data || err.message);
            errorToUpdate.solution = "❌ Failed to get AI solution. Check Debug Console.";
            errorProvider.refresh(errorProvider.errors);
        }
    });

    // Command to show solution in webview & TTS (UNCHANGED style)
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
        background: radial-gradient(circle at top left, #0f2027, #203a43, #2c5364);
        color: #e0e0e0;
        line-height: 1.8;
        display: flex;
        justify-content: center;
    }

    .container {
        max-width: 900px;
        width: 100%;
        max-height: 70vh;
        overflow-y: auto;
        padding: 30px 35px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 20px;
        backdrop-filter: blur(18px) saturate(180%);
        box-shadow: 0 12px 45px rgba(0,0,0,0.7), inset 0 0 30px rgba(255,255,255,0.05);
        margin-bottom: 30px;
        white-space: pre-wrap;
        word-wrap: break-word;
        font-size: 15px;
    }

    h1, h2, h3 {
        color: #00ffe7;
        margin-bottom: 15px;
    }

    button {
        padding: 14px 28px;
        font-size: 16px;
        font-weight: 600;
        border: none;
        border-radius: 12px;
        background: linear-gradient(135deg, #00ffe7, #007acc);
        color: #121212;
        cursor: pointer;
        transition: all 0.3s ease;
        box-shadow: 0 6px 20px rgba(0,255,231,0.4);
        margin-top: 10px;
    }

    button:hover {
        transform: translateY(-3px) scale(1.05);
        box-shadow: 0 10px 28px rgba(0,255,231,0.6);
        background: linear-gradient(135deg, #00d4ff, #007acc);
    }

    #audio-player-container {
        margin-top: 25px;
        display: flex;
        justify-content: center;
        width: 100%;
    }

    audio {
        width: 100%;
        max-width: 720px;
        height: 52px;
        border-radius: 15px;
        background: #101820;
        box-shadow: 0 8px 25px rgba(0,255,231,0.15), inset 0 0 8px rgba(0,255,231,0.3);
        outline: none;
        overflow: hidden;

        /* Reset */
        -webkit-appearance: none;
        -moz-appearance: none;
        appearance: none;
    }

    /* Chrome & Safari custom controls */
    audio::-webkit-media-controls-panel {
        background: #101820;
        border-radius: 15px;
    }
    audio::-webkit-media-controls-play-button,
    audio::-webkit-media-controls-mute-button {
        filter: invert(100%) hue-rotate(180deg);
    }
    audio::-webkit-media-controls-timeline,
    audio::-webkit-media-controls-current-time-display,
    audio::-webkit-media-controls-time-remaining-display,
    audio::-webkit-media-controls-volume-slider {
        filter: invert(90%) hue-rotate(180deg);
    }

    /* Firefox */
    audio::-moz-media-controls {
        background: #101820;
        color: #fff;
        border-radius: 15px;
    }

    /* Scrollbar Styling */
    .container::-webkit-scrollbar {
        width: 10px;
    }
    .container::-webkit-scrollbar-thumb {
        background: linear-gradient(180deg, #00ffe7, #007acc);
        border-radius: 10px;
    }
    .container::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.05);
        border-radius: 10px;
    }
</style>
</head>
<body>
<div>
    <div class="container">${solutionForHtmlDisplay}</div>
    <button id="speakBtn">🔊 Explain it in Voice</button>
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
                speakBtn.innerText = '🔊 Explain it in Voice';
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
                        }
                        );

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
    context.subscriptions.push(disposableGetExplanation, disposableShowWebview);
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
                console.error(
                    "AI Chat Panel Error:",
                    e.response?.data || e.message
                );
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
                        voice_id: "en-US-natalie", // change voice if needed
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
                console.error(
                    "Murf TTS Error:",
                    err.response?.data || err.message
                );
            }
        }
    });
}

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
    padding: 16px 0;
}
#chat {
    flex: 1;
    overflow-y: auto;
    padding: 16px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    scroll-behavior: smooth;
    background: var(--chat-bg);
    border-radius: 20px;
    margin: 0 16px;
}
.row { display: flex; flex-direction: column; }
.msg {
    max-width: 70%;
    padding: 12px 16px;
    border-radius: 20px;
    line-height: 1.4;
    word-wrap: break-word;
    box-shadow: 0 2px 10px rgba(0,0,0,0.4);
}
.user { 
    align-self: flex-end;
    background: var(--user-bg); 
    color: var(--user-color); 
    border-bottom-right-radius: 4px;
}
.ai { 
    align-self: flex-start; 
    background: var(--ai-bg); 
    color: var(--ai-color); 
    border-bottom-left-radius: 4px;
}
.meta { font-size: 12px; margin-bottom: 4px; opacity: 0.7; }
pre {
    margin: 0;
    font-family: monospace;
    white-space: pre-wrap;
}
.read-btn {
    margin-top: 6px;
    font-size: 12px;
    cursor: pointer;
    color: #0b74ff;
    text-decoration: underline;
}
#composer {
    display: flex;
    padding: 10px 16px;
    gap: 8px;
    background: var(--chat-bg);
    border-radius: 20px;
    margin: 0 16px;
    align-items: center;
}
#input {
    flex: 1;
    border-radius: 20px;
    padding: 0 14px;
    border: 1px solid var(--input-border);
    outline: none;
    font-family: 'Poppins', sans-serif;
    resize: vertical;
    max-height: 120px;
    background: var(--input-bg);
    color: #e6edf3;
}
#input:focus { border-color: var(--user-bg); box-shadow: 0 0 4px rgba(11,116,255,0.3); }
button {
    padding: 0 16px;
    height: 40px;
    border-radius: 9999px;
    border: none;
    background: var(--user-bg);
    color: var(--user-color);
    cursor: pointer;
    font-size: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.2s ease;
}
button:hover { background: #005ecb; }
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
