import { Container, Typography } from "@mui/material";
import ChatBox from "@/components/ChatBox";

export default function Home() {
  return (
    <Container maxWidth="md" sx={{ py: { xs: 2, sm: 3 } }}>
      {/* Compact wordmark — the chat is the page now. */}
      <Typography variant="h1" component="h1" align="center" sx={{ fontSize: { xs: "2.5rem", sm: "3.5rem" } }}>
        hearthkeeper
      </Typography>
      <Typography variant="body2" component="p" align="center" sx={{ mt: 0.5, color: "text.secondary" }}>
        campfire MVP — responses are read aloud
      </Typography>
      <ChatBox />
    </Container>
  );
}