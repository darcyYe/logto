import {
  type ApplicationAccessControl,
  ApplicationType,
  createDefaultApplicationAccessControl,
  RoleType,
  type SamlApplicationResponse,
} from '@logto/schemas';

import { authedAdminApi } from '#src/api/api.js';
import {
  createApplication,
  deleteApplication,
  getApplication,
  getApplicationAccessControl,
  getApplications,
  replaceApplicationAccessControl,
  updateApplication,
} from '#src/api/application.js';
import { assignUsersToRole, createRole, deleteRole } from '#src/api/role.js';
import {
  deleteSamlApplication,
  getSamlApplication,
  updateSamlApplication,
} from '#src/api/saml-application.js';
import { logtoConsoleUrl as logtoConsoleUrlString } from '#src/constants.js';
import { OrganizationApiTest } from '#src/helpers/organization.js';
import {
  createDefaultTenantUserWithPassword,
  deleteDefaultTenantUser,
} from '#src/helpers/profile.js';
import {
  expectToClickModalAction,
  expectToSaveChanges,
  goToAdminConsole,
  waitForToast,
} from '#src/ui-helpers/index.js';
import { appendPathname, devFeatureTest, expectNavigation, generateTestName } from '#src/utils.js';

await page.setViewport({ width: 1920, height: 1080 });

const createOrReuseSamlApplication = async () => {
  const response = await authedAdminApi.post('saml-applications', {
    json: {
      name: generateTestName(),
      description: null,
    },
    throwHttpErrors: false,
  });

  if (response.ok) {
    return {
      application: await response.json<SamlApplicationResponse>(),
      shouldDelete: true,
    };
  }

  const error = await response.json<{ code?: string }>();
  if (response.status === 403 && error.code === 'application.saml.reach_oss_limit') {
    const [application] = await getApplications([ApplicationType.SAML]);

    expect(application).toBeDefined();

    return {
      application: application!,
      shouldDelete: false,
    };
  }

  throw new Error(`Failed to create SAML application: ${response.status} ${error.code ?? ''}`);
};

const resetOrDeleteSamlApplication = async ({
  application,
  shouldDelete,
}: Awaited<ReturnType<typeof createOrReuseSamlApplication>>) => {
  if (shouldDelete) {
    await deleteSamlApplication(application.id);
    return;
  }

  await updateSamlApplication(application.id, { appLevelAccessControlEnabled: false });
  await replaceApplicationAccessControl(application.id, createDefaultApplicationAccessControl());
};

const createAccessControlFixtures = async () => {
  const organizationApi = new OrganizationApiTest();
  const { user, username } = await createDefaultTenantUserWithPassword();
  const userRole = await createRole({ name: generateTestName(), type: RoleType.User });
  const [organization, organizationWithRole] = await Promise.all([
    organizationApi.create({ name: generateTestName() }),
    organizationApi.create({ name: generateTestName() }),
  ]);
  const organizationRole = await organizationApi.roleApi.create({
    name: generateTestName(),
    type: RoleType.User,
  });

  await Promise.all([
    assignUsersToRole([user.id], userRole.id),
    organizationApi.addUsers(organization.id, [user.id]),
    organizationApi.addUsers(organizationWithRole.id, [user.id]),
  ]);
  await organizationApi.addUserRoles(organizationWithRole.id, user.id, [organizationRole.id]);

  return {
    accessControl: {
      ...createDefaultApplicationAccessControl(),
      userIds: [user.id],
      userRoleIds: [userRole.id],
      organizationIds: [organization.id],
      organizationRoleRules: [
        {
          organizationId: organizationWithRole.id,
          organizationRoleIds: [organizationRole.id],
        },
      ],
    } satisfies ApplicationAccessControl,
    tableDetails: {
      username,
      userId: user.id,
      userRoleName: userRole.name,
      organizationName: organization.name,
      organizationRoleRuleName: `${organizationWithRole.name} - ${organizationRole.name}`,
    },
    cleanup: async () =>
      Promise.allSettled([
        deleteDefaultTenantUser(user.id),
        deleteRole(userRole.id),
        organizationApi.cleanUp(),
      ]),
  };
};

const expectAccessControlTableDetails = async ({
  username,
  userId,
  userRoleName,
  organizationName,
  organizationRoleRuleName,
}: Awaited<ReturnType<typeof createAccessControlFixtures>>['tableDetails']) => {
  await expect(page).toMatchElement('table tbody tr td', { text: username });
  await expect(page).toMatchElement('table tbody tr td', { text: userId });
  await expect(page).toMatchElement('table tbody tr td', { text: userRoleName });
  await expect(page).toMatchElement('table tbody tr td', { text: organizationName });
  await expect(page).toMatchElement('table tbody tr td', { text: organizationRoleRuleName });
};

devFeatureTest.describe('application access control Console', () => {
  const logtoConsoleUrl = new URL(logtoConsoleUrlString);

  beforeAll(async () => {
    await goToAdminConsole();
  });

  it('renders rules tab and table details, then saves enabled-state changes', async () => {
    const accessControlFixtures = await createAccessControlFixtures();
    const [application, machineToMachineApplication] = await Promise.all([
      createApplication(generateTestName(), ApplicationType.SPA),
      createApplication(generateTestName(), ApplicationType.MachineToMachine),
    ]);

    try {
      await replaceApplicationAccessControl(application.id, accessControlFixtures.accessControl);
      await updateApplication(application.id, { appLevelAccessControlEnabled: true });

      await expectNavigation(
        page.goto(
          appendPathname(
            `/console/applications/${machineToMachineApplication.id}/settings`,
            logtoConsoleUrl
          ).href
        )
      );
      await expect(page).toMatchElement('nav a', { text: 'Settings' });

      const machineToMachineRulesTabCount = await page.$$eval(
        'nav a',
        (links) => links.filter((link) => link.textContent?.trim() === 'Rules').length
      );
      expect(machineToMachineRulesTabCount).toBe(0);

      await expectNavigation(
        page.goto(
          appendPathname(`/console/applications/${application.id}/rules`, logtoConsoleUrl).href
        )
      );

      await expect(page).toMatchElement('nav a', { text: 'Rules' });
      await expect(page).toMatchElement('div[class$=title]', {
        text: 'Enable app-level access control',
      });
      await page.waitForSelector('label[class$=switch] input:not(:disabled)');

      const isEnabled = await page.$eval('label[class$=switch] input', (input) => input.checked);
      expect(isEnabled).toBe(true);

      await expectAccessControlTableDetails(accessControlFixtures.tableDetails);

      await expect(page).toClick('label[class$=switch]');
      await expectToSaveChanges(page);
      await waitForToast(page, { text: 'Saved' });

      await expect(getApplication(application.id)).resolves.toMatchObject({
        appLevelAccessControlEnabled: false,
      });
    } finally {
      await Promise.allSettled([
        deleteApplication(application.id),
        deleteApplication(machineToMachineApplication.id),
        accessControlFixtures.cleanup(),
      ]);
    }
  });

  it('renders SAML rules tab and table details, then saves enabled-state changes', async () => {
    const samlApplicationFixtures = await createOrReuseSamlApplication();
    const accessControlFixtures = await createAccessControlFixtures();
    const { application: samlApplication } = samlApplicationFixtures;

    try {
      await replaceApplicationAccessControl(
        samlApplication.id,
        accessControlFixtures.accessControl
      );
      await updateSamlApplication(samlApplication.id, { appLevelAccessControlEnabled: true });

      await expectNavigation(
        page.goto(
          appendPathname(`/console/applications/${samlApplication.id}/rules`, logtoConsoleUrl).href
        )
      );

      await expect(page).toMatchElement('nav a', { text: 'Rules' });
      await expect(page).toMatchElement('div[class$=title]', {
        text: 'Enable app-level access control',
      });
      await page.waitForSelector('label[class$=switch] input:not(:disabled)');

      const isEnabled = await page.$eval('label[class$=switch] input', (input) => input.checked);
      expect(isEnabled).toBe(true);

      await expectAccessControlTableDetails(accessControlFixtures.tableDetails);

      await expect(page).toClick('label[class$=switch]');
      await expectToSaveChanges(page);
      await waitForToast(page, { text: 'Saved' });

      await expect(getSamlApplication(samlApplication.id)).resolves.toMatchObject({
        appLevelAccessControlEnabled: false,
      });
    } finally {
      await Promise.allSettled([
        resetOrDeleteSamlApplication(samlApplicationFixtures),
        accessControlFixtures.cleanup(),
      ]);
    }
  });

  it('adds and removes user rules from the rules tab', async () => {
    const { user, username } = await createDefaultTenantUserWithPassword();
    const application = await createApplication(generateTestName(), ApplicationType.SPA);

    try {
      await expectNavigation(
        page.goto(
          appendPathname(`/console/applications/${application.id}/rules`, logtoConsoleUrl).href
        )
      );

      await expect(page).toClick('label[class$=switch]');
      await expect(page).toClick('button span', { text: 'Add rules' });
      await expect(page).toClick('div[role=menuitem]', { text: 'Users' });
      await expect(page).toMatchElement('.ReactModalPortal div[class$=title]', { text: 'Users' });
      await expect(page).toFill('.ReactModalPortal input[placeholder=Search]', username);
      await expect(page).toClick('.ReactModalPortal div[role=button]', { text: username });
      await expectToClickModalAction(page, 'Save');

      await expect(page).toMatchElement('table tbody tr td', { text: username });
      await expectToSaveChanges(page);
      await waitForToast(page, { text: 'Saved' });

      await expect(getApplication(application.id)).resolves.toMatchObject({
        appLevelAccessControlEnabled: true,
      });
      await expect(getApplicationAccessControl(application.id)).resolves.toMatchObject({
        userIds: [user.id],
      });

      await expect(page).toClick('table tbody tr button[aria-label=Remove]');
      await expectToClickModalAction(page, 'Remove');
      await expect(page).toClick('label[class$=switch]');
      await expectToSaveChanges(page);
      await waitForToast(page, { text: 'Saved' });

      await expect(getApplication(application.id)).resolves.toMatchObject({
        appLevelAccessControlEnabled: false,
      });
      await expect(getApplicationAccessControl(application.id)).resolves.toEqual(
        createDefaultApplicationAccessControl()
      );
    } finally {
      await Promise.allSettled([
        deleteApplication(application.id),
        deleteDefaultTenantUser(user.id),
      ]);
    }
  });

  it('adds and removes user rules from the SAML rules tab', async () => {
    const { user, username } = await createDefaultTenantUserWithPassword();
    const samlApplicationFixtures = await createOrReuseSamlApplication();
    const { application: samlApplication } = samlApplicationFixtures;

    try {
      await expectNavigation(
        page.goto(
          appendPathname(`/console/applications/${samlApplication.id}/rules`, logtoConsoleUrl).href
        )
      );

      await expect(page).toClick('label[class$=switch]');
      await expect(page).toClick('button span', { text: 'Add rules' });
      await expect(page).toClick('div[role=menuitem]', { text: 'Users' });
      await expect(page).toMatchElement('.ReactModalPortal div[class$=title]', { text: 'Users' });
      await expect(page).toFill('.ReactModalPortal input[placeholder=Search]', username);
      await expect(page).toClick('.ReactModalPortal div[role=button]', { text: username });
      await expectToClickModalAction(page, 'Save');

      await expect(page).toMatchElement('table tbody tr td', { text: username });
      await expectToSaveChanges(page);
      await waitForToast(page, { text: 'Saved' });

      await expect(getSamlApplication(samlApplication.id)).resolves.toMatchObject({
        appLevelAccessControlEnabled: true,
      });
      await expect(getApplicationAccessControl(samlApplication.id)).resolves.toMatchObject({
        userIds: [user.id],
      });

      await expect(page).toClick('table tbody tr button[aria-label=Remove]');
      await expectToClickModalAction(page, 'Remove');
      await expect(page).toClick('label[class$=switch]');
      await expectToSaveChanges(page);
      await waitForToast(page, { text: 'Saved' });

      await expect(getSamlApplication(samlApplication.id)).resolves.toMatchObject({
        appLevelAccessControlEnabled: false,
      });
      await expect(getApplicationAccessControl(samlApplication.id)).resolves.toEqual(
        createDefaultApplicationAccessControl()
      );
    } finally {
      await Promise.allSettled([
        resetOrDeleteSamlApplication(samlApplicationFixtures),
        deleteDefaultTenantUser(user.id),
      ]);
    }
  });
});
