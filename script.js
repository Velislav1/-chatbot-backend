const SERVER_URL = "https://chatbot-backend-19zm.onrender.com";

    function generateUUID() {
      return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }

    const sessionId = localStorage.getItem("sessionId") || generateUUID();
    localStorage.setItem("sessionId", sessionId);
    const chatHistory = [];
    const messagesDiv = document.getElementById("messages");

    function updateChat() {
      messagesDiv.innerHTML = chatHistory.map(msg => {
        const avatar = msg.role === 'user' ? '' : '<img src="https://img.icons8.com/color/48/bot.png" class="avatar"/>';
        return `<div class="${msg.role}">${avatar}<div class="bubble">${msg.content}</div></div>`;
      }).join("");
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    async function sendMessage(message) {
      if (!message) return;

      chatHistory.push({ role: "user", content: message });
      updateChat();

      chatHistory.push({ role: "bot", content: '<span class="typing">Typing...</span>' });
      updateChat();

      try {
        const res = await fetch(`${SERVER_URL}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ question: message, sessionId })
        });
        const data = await res.json();
        chatHistory.pop();
        chatHistory.push({ role: "bot", content: data.message || "⚠️ No response" });
        updateChat();
      } catch (err) {
        chatHistory.pop();
        chatHistory.push({ role: "bot", content: "❌ Error: " + err.message });
        updateChat();
      }
    }

    function clearChat() {
      chatHistory.length = 0;
      welcomeMessages();
    }

    function toggleDarkMode() {
      document.body.classList.toggle("dark-mode");
    }

    function welcomeMessages() {
      chatHistory.push({ role: "bot", content: "👋 Hi! I'm Prime Insurance Agent. How can I help you today?" });
      chatHistory.push({ role: "bot", content: "📄 <button onclick='alert(\"Upload PDF coming soon!\")'>Upload a PDF file</button>" });
      chatHistory.push({ role: "bot", content: "📅 <button class='calendar-btn' onclick=\"window.open('https://calendly.com/viliokaized', '_blank')\">Book a meeting</button>" });
      chatHistory.push({ role: "bot", content: "🤖 You can also ask questions or become a client right here." });
      updateChat();
    }

    setTimeout(() => {
      welcomeMessages();
    }, 5000);

    document.getElementById("question").addEventListener("keypress", function (e) {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const msg = this.value.trim();
        this.value = "";
        sendMessage(msg);
      }
    });
  </script>

</body>
</html>

