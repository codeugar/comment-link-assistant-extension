interface SidePanelBehaviorApi {
  setPanelBehavior(
    behavior: chrome.sidePanel.PanelBehavior
  ): Promise<void> | void;
}

export async function configureSidePanel(
  sidePanel: SidePanelBehaviorApi
): Promise<void> {
  await sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
}
