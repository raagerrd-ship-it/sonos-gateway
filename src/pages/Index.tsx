const Index = () => {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-background p-8">
      <div className="max-w-lg text-center">
        <h1 className="text-3xl font-bold text-foreground mb-4">🔊 Sonos Proxy</h1>
        <p className="text-muted-foreground mb-6">
          Fristående Node.js-proxy för Sonos UPnP med SSDP-discovery, SSE-streaming och webb-UI.
        </p>
        <div className="text-left bg-muted rounded-lg p-4 text-sm font-mono text-muted-foreground space-y-1">
          <p>cd bridge</p>
          <p>npm install</p>
          <p>cp .env.example .env</p>
          <p>node index.js</p>
        </div>
        <p className="text-xs text-muted-foreground mt-4">
          Se <code className="bg-muted px-1 rounded">bridge/README.md</code> för fullständig dokumentation.
        </p>
      </div>
    </div>
  );
};

export default Index;
