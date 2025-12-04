# Disk Defender

**Disk Defender** is a competitive multiplayer educational game that simulates Operating System Disk Scheduling. Teams compete to service I/O requests, manage system resources, and sabotage rivals in a high-stakes battle for CPU dominance.

## 🎮 Game Overview

*   **Goal:** Service I/O requests to prevent "Starvation" (Explosions) and maintain System HP.
*   **Win Condition:** Have the highest score after 5 minutes OR be the last team standing.
*   **Teams:** Up to 3 Teams (A, B, C) with 3 Players each (9 Players Total).
*   **Bots:** AI bots automatically fill empty slots to ensure balanced gameplay.

## 👥 Roles

Each team consists of three specialized roles. Cooperation is key to survival.

### 1. 🏎️ The Driver
*   **Responsibility:** Controls the physical Disk Arm.
*   **Action:** Moves the arm to specific sectors (0-199) to service requests.
*   **Challenge:** The arm has inertia and momentum. Precision is required.

### 2. 📅 The Scheduler
*   **Responsibility:** Optimizes the queue.
*   **Action:** Highlights priority requests for the Driver and drops low-value/dangerous requests to save time.
*   **Challenge:** Must balance request aging (Green -> Yellow -> Red) against travel time.

### 3. 💻 The Hacker
*   **Responsibility:** Cyber warfare and resource management.
*   **Action:** Uses "Cache" (earned by servicing requests) to launch attacks on rival teams.
*   **Attacks:**
    *   **Freeze:** Locks the rival Driver's controls.
    *   **Ghost:** Spams fake requests to confuse the enemy.
    *   **Shuffle:** Scrambles the visual sector numbers.

## 🛠️ Installation & Setup

### Prerequisites
*   [Node.js](https://nodejs.org/) (v16 or higher)
*   npm (Node Package Manager)

### Running Locally

1.  **Clone the repository**
    ```bash
    git clone https://github.com/laeyue/diskdefender.git
    cd diskdefender
    ```

2.  **Install Dependencies**
    ```bash
    npm install
    ```

3.  **Start the Development Server**
    This command starts both the Backend (Socket.io) and Frontend (Vite) concurrently.
    ```bash
    npm run dev
    ```

4.  **Play**
    Open your browser and navigate to `http://localhost:5173` (or the port shown in your terminal). Open multiple tabs to simulate multiple players.

## 🏗️ Tech Stack

*   **Frontend:** React, Vite, TailwindCSS
*   **Backend:** Node.js, Express
*   **Real-time Communication:** Socket.io
*   **Architecture:** Authoritative Server with Client-Side Prediction

## 📂 Project Structure

*   `server.js` - The authoritative game server handling game loops, validation, and state.
*   `src/App.jsx` - The main React application containing game logic, UI, and rendering.
*   `src/components/` - Reusable UI components.
*   `codedocumentation.md` - Detailed technical documentation of the codebase.

## 📜 License

This project is open-source and available under the MIT License.
