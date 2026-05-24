#!/bin/bash
set -e

# Gombwe installer
# Usage: curl -fsSL https://gombwe.com/install.sh | bash

BOLD="\033[1m"
DIM="\033[2m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

echo ""
echo -e "${BOLD}gombwe${RESET} — autonomous agent runtime"
echo -e "${DIM}https://gombwe.com${RESET}"
echo ""

# Detect OS
OS="$(uname -s)"
ARCH="$(uname -m)"

# Check for Node.js
if command -v node &>/dev/null; then
  NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
  if [ "$NODE_VERSION" -ge 18 ]; then
    echo -e "${GREEN}✓${RESET} Node.js $(node -v) found"
  else
    echo -e "${YELLOW}!${RESET} Node.js $(node -v) found but v18+ required"
    echo ""
    NEED_NODE=true
  fi
else
  echo -e "${YELLOW}!${RESET} Node.js not found"
  echo ""
  NEED_NODE=true
fi

# Install Node.js if needed
if [ "$NEED_NODE" = true ]; then
  echo -e "${BOLD}Installing Node.js...${RESET}"
  echo ""

  if [ "$OS" = "Darwin" ]; then
    # macOS
    if command -v brew &>/dev/null; then
      echo -e "${DIM}Using Homebrew...${RESET}"
      brew install node
    else
      echo -e "${DIM}Downloading from nodejs.org...${RESET}"
      if [ "$ARCH" = "arm64" ]; then
        NODE_URL="https://nodejs.org/dist/v22.12.0/node-v22.12.0-darwin-arm64.tar.gz"
      else
        NODE_URL="https://nodejs.org/dist/v22.12.0/node-v22.12.0-darwin-x64.tar.gz"
      fi
      curl -fsSL "$NODE_URL" -o /tmp/node.tar.gz
      sudo mkdir -p /usr/local/lib/nodejs
      sudo tar -xzf /tmp/node.tar.gz -C /usr/local/lib/nodejs
      NODE_DIR=$(tar -tzf /tmp/node.tar.gz | head -1 | cut -d/ -f1)
      echo "export PATH=/usr/local/lib/nodejs/$NODE_DIR/bin:\$PATH" >> ~/.bashrc
      echo "export PATH=/usr/local/lib/nodejs/$NODE_DIR/bin:\$PATH" >> ~/.zshrc
      export PATH="/usr/local/lib/nodejs/$NODE_DIR/bin:$PATH"
      rm /tmp/node.tar.gz
    fi

  elif [ "$OS" = "Linux" ]; then
    # Linux
    if command -v apt-get &>/dev/null; then
      echo -e "${DIM}Using apt...${RESET}"
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
    elif command -v dnf &>/dev/null; then
      echo -e "${DIM}Using dnf...${RESET}"
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo dnf install -y nodejs
    elif command -v yum &>/dev/null; then
      echo -e "${DIM}Using yum...${RESET}"
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo bash -
      sudo yum install -y nodejs
    else
      echo -e "${RED}✗${RESET} Could not detect package manager. Install Node.js 18+ manually from https://nodejs.org"
      exit 1
    fi

  else
    echo -e "${RED}✗${RESET} Unsupported OS: $OS"
    echo "  Install Node.js 18+ manually from https://nodejs.org"
    exit 1
  fi

  # Verify
  if command -v node &>/dev/null; then
    echo -e "${GREEN}✓${RESET} Node.js $(node -v) installed"
  else
    echo -e "${RED}✗${RESET} Node.js installation failed. Install manually from https://nodejs.org"
    exit 1
  fi
  echo ""
fi

# Install Gombwe
echo -e "${BOLD}Installing Gombwe...${RESET}"
npm install -g claude-gombwe

echo ""
echo -e "${GREEN}✓${RESET} Gombwe installed"
echo ""
echo -e "  ${BOLD}Get started:${RESET}"
echo ""
echo "    gombwe init       # set up config"
echo "    gombwe start      # launch the agent"
echo ""
echo -e "  ${DIM}Dashboard: http://localhost:18790${RESET}"
echo -e "  ${DIM}Docs: https://gombwe.com${RESET}"
echo ""
